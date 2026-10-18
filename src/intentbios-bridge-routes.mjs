/**
 * Wrapper routes Intentbios calls (gateway bearer only; nothing here is open):
 *   POST /intentbios/discord/mirror  Ask turns → the intent's Discord thread. Posts directly
 *                                    over Discord REST: no agent run, no model tokens.
 *   POST /intentbios/discord/thread  Open a thread in #intents for an intent and post the
 *                                    conversation so far; records the intent → thread mapping.
 *   GET  /intentbios/souls           Each agent's persona files, read-only, secrets redacted.
 */
import fs from "node:fs";
import path from "node:path";

import {
  claimUnmirrored,
  createThread,
  mirrorMessages,
  postMessage,
  recordThread,
  redactSecrets,
  threadForIntent,
} from "../plugins/intentbios/discord-bridge.mjs";
import { KNOWLEDGE_BEGIN, KNOWLEDGE_END } from "./discord-coding-config.mjs";

const SOUL_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md"];
const MAX_FILE_CHARS = 24_000;
const INTENT_ID = /^[A-Za-z0-9_-]{3,80}$/;

const https = (v) => typeof v === "string" && /^https:\/\/\S+$/.test(v) && v.length <= 2048;

/** Keep only well-formed turns; text capped; links https only. */
export function cleanTurns(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 12).map((t) => ({
    id: String(t?.id || "").slice(0, 80),
    role: t?.role === "user" ? "user" : "coach",
    text: String(t?.text || "").slice(0, 3_500),
    figures: (Array.isArray(t?.figures) ? t.figures : []).filter((f) => https(f?.pngUrl)).slice(0, 4)
      .map((f) => ({ title: String(f.title || "Figure").slice(0, 200), pngUrl: f.pngUrl })),
    equations: (Array.isArray(t?.equations) ? t.equations : []).filter((e) => https(e?.pngUrl)).slice(0, 4)
      .map((e) => ({ pngUrl: e.pngUrl })),
  })).filter((t) => t.id && t.text.trim());
}

function readSoulFile(dir, name, secrets) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return { name, content: "", missing: true };
  let content = fs.readFileSync(file, "utf8");
  if (name === "AGENTS.md") {
    // The managed Intentbios knowledge block first (what the agent knows about Intentbios).
    const start = content.indexOf(KNOWLEDGE_BEGIN);
    const end = content.indexOf(KNOWLEDGE_END);
    if (start >= 0 && end > start) {
      const block = content.slice(start, end + KNOWLEDGE_END.length);
      content = `${block}\n\n--- rest of AGENTS.md ---\n${content.slice(0, start)}${content.slice(end + KNOWLEDGE_END.length)}`;
    }
  }
  const truncated = content.length > MAX_FILE_CHARS;
  return { name, content: redactSecrets(content.slice(0, MAX_FILE_CHARS), secrets), ...(truncated ? { truncated: true } : {}) };
}

/** Agents and their workspaces, from openclaw.json (fallbacks: main → default workspace). */
export function listAgentWorkspaces({ configFile, stateDir, workspaceDir }) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { config = {}; }
  const entries = config?.agents?.entries && typeof config.agents.entries === "object" ? config.agents.entries : {};
  const defaultWs = config?.agents?.defaults?.workspace || workspaceDir;
  const ids = Array.from(new Set(["main", "planner", "intentbios-coach", ...Object.keys(entries)]));
  return ids.map((id) => {
    const entry = entries[id] || {};
    const fallback = id === "intentbios-coach" ? path.join(stateDir, "workspaces", "intentbios-coach") : defaultWs;
    const workspace = String(entry.workspace || fallback);
    return {
      id,
      name: entry.name || entry.identity?.name || id,
      role: typeof entry.model === "string" ? entry.model : entry.model?.primary || "",
      workspace,
      ...(id !== "main" && workspace === defaultWs ? { sharedWith: "main" } : {}),
    };
  });
}

/** Read a JSON body (≤256 KB) from a plain Node request. */
function readJson(req, limit = 256 * 1024) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

const ROUTES = new Set(["POST /intentbios/discord/mirror", "POST /intentbios/discord/thread", "GET /intentbios/souls"]);

/**
 * One middleware for the three routes (plain Node req/res, so it needs no framework).
 * Anything else falls through to `next`.
 */
export function createIntentbiosBridgeHandler({
  isAuthorized,
  stateDir,
  workspaceDir,
  configFile,
  intentsChannelId,
  token = () => process.env.DISCORD_BOT_TOKEN,
  secrets = () => [],
  post = postMessage,
  newThread = createThread,
  log = () => {},
}) {
  const mirror = async (body) => {
    const intentId = String(body?.intentId || "").trim();
    if (!INTENT_ID.test(intentId)) return [400, { error: "intentId required" }];
    const row = threadForIntent(stateDir, intentId);
    if (!row) return [200, { ok: true, mapped: false, mirrored: 0 }];
    if (!token()) return [503, { error: "Discord is not configured" }];
    const turns = cleanTurns(body?.turns);
    const fresh = new Set(claimUnmirrored(stateDir, intentId, turns.map((t) => t.id)));
    const batch = turns.filter((t) => fresh.has(t.id));
    if (!batch.length) return [200, { ok: true, mapped: true, mirrored: 0 }];
    try {
      for (const message of mirrorMessages(batch)) await post(token(), row.threadId, message);
      log("info", `mirrored ${batch.length} Ask turn(s) for ${intentId} to thread ${row.threadId}`);
      return [200, { ok: true, mapped: true, mirrored: batch.length }];
    } catch (err) {
      log("warn", `mirror failed for ${intentId}: ${err.message}`);
      return [502, { error: err.message }];
    }
  };

  const openThread = async (body) => {
    const intentId = String(body?.intentId || "").trim();
    if (!INTENT_ID.test(intentId)) return [400, { error: "intentId required" }];
    const existing = threadForIntent(stateDir, intentId);
    if (existing) return [200, { ok: true, existing: true, threadId: existing.threadId, url: existing.url || null }];
    if (!token()) return [503, { error: "Discord is not configured" }];
    if (!intentsChannelId) return [503, { error: "No #intents channel configured" }];
    const title = String(body?.title || intentId).replace(/\s+/g, " ").trim().slice(0, 90);
    // Intentbios sends "<title> · <intentId>", the name the coach uses for threads it opens.
    const threadName = String(body?.threadName || "").replace(/\s+/g, " ").trim().slice(0, 100) || title;
    const turns = cleanTurns(body?.turns);
    try {
      const thread = await newThread(token(), intentsChannelId, threadName);
      const url = thread.guild_id ? `https://discord.com/channels/${thread.guild_id}/${thread.id}` : null;
      recordThread(stateDir, intentId, thread.id, { source: "ask", url });
      await post(token(), thread.id, {
        content: `🧭 **${title}** · intent \`${intentId}\`\nOpened from Ask. Reply here to keep talking to your coach; messages typed in Ask show up here too.`,
      });
      claimUnmirrored(stateDir, intentId, turns.map((t) => t.id));
      for (const message of mirrorMessages(turns, { header: "📱 **from Ask** — the conversation so far" })) {
        await post(token(), thread.id, message);
      }
      log("info", `opened thread ${thread.id} for ${intentId}`);
      return [200, { ok: true, threadId: thread.id, url }];
    } catch (err) {
      log("warn", `thread open failed for ${intentId}: ${err.message}`);
      return [502, { error: err.message }];
    }
  };

  const souls = () => {
    const extra = secrets();
    const agents = listAgentWorkspaces({ configFile, stateDir, workspaceDir }).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      ...(agent.sharedWith ? { sharedWith: agent.sharedWith } : {}),
      files: SOUL_FILES.map((name) => readSoulFile(agent.workspace, name, extra)),
    }));
    return [200, { ok: true, agents }];
  };

  return async (req, res, next) => {
    const route = `${req.method} ${String(req.url || "").split("?")[0]}`;
    if (!ROUTES.has(route)) return next?.();
    if (!isAuthorized(req)) return send(res, 401, { error: "unauthorized" });
    try {
      if (route === "GET /intentbios/souls") return send(res, ...souls());
      const body = await readJson(req);
      const [status, payload] = route.endsWith("/mirror") ? await mirror(body) : await openThread(body);
      return send(res, status, payload);
    } catch (err) {
      return send(res, err?.status || 500, { error: err?.message || "failed" });
    }
  };
}
