/**
 * Discord bridge for Intentbios (deterministic; no model involved).
 *
 * Shared by the intentbios plugin (inside the gateway) and the wrapper server:
 *  - the intent → Discord thread mapping ($OPENCLAW_STATE_DIR/intentbios/discord-threads.json)
 *  - finding the coach card in a tool result, and turning its figures/equations into embeds
 *  - posting to Discord over REST with the bot token (never logged, never returned)
 *  - formatting Ask turns mirrored into a thread ("📱 from Ask")
 *  - redacting secrets from persona files (Debug "Souls")
 */
import fs from "node:fs";
import path from "node:path";

export const DISCORD_API = "https://discord.com/api/v10";
const MAX_CONTENT = 2000;
const MAX_EMBEDS = 10;
const MAX_MIRRORED_IDS = 300;

// ---------------------------------------------------------------------------
// Mapping store

export function mappingPath(stateDir) {
  return path.join(String(stateDir || ""), "intentbios", "discord-threads.json");
}

export function readMapping(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(mappingPath(stateDir), "utf8"));
    return raw && typeof raw === "object" && raw.intents && typeof raw.intents === "object" ? raw : { intents: {} };
  } catch {
    return { intents: {} };
  }
}

function writeMapping(stateDir, mapping) {
  const file = mappingPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

const INTENT_ID = /^[A-Za-z0-9_-]{3,80}$/;
const SNOWFLAKE = /^\d{15,25}$/;

/** Remember (or move) the Discord thread an intent's conversation lives in. */
export function recordThread(stateDir, intentId, threadId, meta = {}) {
  const id = String(intentId || "").trim();
  const thread = String(threadId || "").trim();
  if (!INTENT_ID.test(id) || !SNOWFLAKE.test(thread)) return false;
  const mapping = readMapping(stateDir);
  const prev = mapping.intents[id] || {};
  if (prev.threadId === thread && !meta.source) return true;
  mapping.intents[id] = {
    ...prev,
    threadId: thread,
    updatedAt: new Date().toISOString(),
    source: meta.source || prev.source || "coach",
    ...(meta.url ? { url: meta.url } : prev.threadId === thread && prev.url ? { url: prev.url } : {}),
    mirrored: prev.threadId === thread ? prev.mirrored || [] : [],
  };
  writeMapping(stateDir, mapping);
  return true;
}

export function threadForIntent(stateDir, intentId) {
  const row = readMapping(stateDir).intents[String(intentId || "").trim()];
  return row && SNOWFLAKE.test(String(row.threadId || "")) ? row : null;
}

/** Turn ids not yet mirrored for an intent; marks them mirrored. */
export function claimUnmirrored(stateDir, intentId, turnIds) {
  const mapping = readMapping(stateDir);
  const row = mapping.intents[intentId];
  if (!row) return [];
  const seen = new Set(row.mirrored || []);
  const fresh = turnIds.filter((id) => id && !seen.has(id));
  if (!fresh.length) return [];
  row.mirrored = [...(row.mirrored || []), ...fresh].slice(-MAX_MIRRORED_IDS);
  writeMapping(stateDir, mapping);
  return fresh;
}

// ---------------------------------------------------------------------------
// Session keys and cards

/** The Discord channel/thread a session key points at (`agent:main:discord:channel:<id>`). */
export function discordChannelFromSessionKey(sessionKey) {
  const key = String(sessionKey || "");
  if (!/(^|:)discord:/.test(key)) return null;
  const matches = [...key.matchAll(/(?:^|:)(?:channel|thread):(\d{15,25})(?=$|:)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

const COACH_TOOL = /(^|__|\.)(intent_create|journey_message|coach_status|lesson_status|state_snapshot|intent_execute|step_done|journey_initiate)$/;
export function isIntentbiosTool(toolName) {
  const name = String(toolName || "");
  return COACH_TOOL.test(name) || name.startsWith("intentbios__");
}

function isCard(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof value.reply === "string" && (typeof value.deepLink === "string" || Array.isArray(value.figures) || typeof value.intentId === "string");
}

/** Find the coach card in a tool result (structuredContent, details, JSON text blocks, nested output). */
export function extractCard(result, depth = 0) {
  if (depth > 6 || result == null) return null;
  if (typeof result === "string") {
    const text = result.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try { return extractCard(JSON.parse(text), depth + 1); } catch { /* fall through */ }
    }
    // MCP results rendered as text ("structuredContent:\n{...}"): the JSON object inside.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return extractCard(JSON.parse(text.slice(start, end + 1)), depth + 1); } catch { return null; }
  }
  if (typeof result !== "object") return null;
  if (isCard(result)) return result;
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = extractCard(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ["structuredContent", "details", "output", "card", "coachCard", "result", "content", "text"]) {
    if (key in result) {
      const found = extractCard(result[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const httpsUrl = (value) => typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2048;

/** Figures (title + image) and display equations (image) as Discord embeds. */
export function embedsForCard(card) {
  const embeds = [];
  for (const fig of Array.isArray(card?.figures) ? card.figures : []) {
    if (!httpsUrl(fig?.pngUrl)) continue;
    embeds.push({ title: String(fig.title || "Figure").slice(0, 256), image: { url: fig.pngUrl } });
  }
  for (const eq of Array.isArray(card?.equations) ? card.equations : []) {
    if (!httpsUrl(eq?.pngUrl)) continue;
    embeds.push({ image: { url: eq.pngUrl } });
  }
  return embeds.slice(0, MAX_EMBEDS);
}

export function dedupeEmbeds(embeds) {
  const seen = new Set();
  return embeds.filter((embed) => {
    const url = embed?.image?.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Discord REST

export async function discordRequest(token, method, route, body, fetchImpl = fetch) {
  if (!token) throw new Error("Discord bot token is not configured");
  const res = await fetchImpl(`${DISCORD_API}${route}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "IntentbiosBridge (https://github.com/gguarina, 1.0)" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const err = new Error(`Discord ${method} ${route.replace(/\d{15,25}/g, ":id")} → ${res.status}${json?.message ? ` (${String(json.message).slice(0, 120)})` : ""}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Post one message (content and/or embeds); mentions are never pinged. */
export function postMessage(token, channelId, { content = "", embeds = [] }, fetchImpl = fetch) {
  const body = { allowed_mentions: { parse: [] } };
  if (content) body.content = content.slice(0, MAX_CONTENT);
  if (embeds.length) body.embeds = embeds.slice(0, MAX_EMBEDS);
  return discordRequest(token, "POST", `/channels/${channelId}/messages`, body, fetchImpl);
}

/** Start a public thread (no starter message) in a text channel. */
export function createThread(token, parentId, name, fetchImpl = fetch) {
  return discordRequest(token, "POST", `/channels/${parentId}/threads`, {
    name: String(name || "Intent").replace(/\s+/g, " ").trim().slice(0, 100) || "Intent",
    type: 11,
    auto_archive_duration: 10080,
  }, fetchImpl);
}

// ---------------------------------------------------------------------------
// Mirrored turns

function splitText(text, limit) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Discord messages for a batch of turns: one "📱 from Ask" header, "You:" / "Coach:"
 * lines, split under 2000 chars; embeds ride on the last message.
 */
export function mirrorMessages(turns, { header = "📱 **from Ask**" } = {}) {
  const lines = [];
  const embeds = [];
  for (const turn of turns) {
    const text = String(turn?.text || "").trim();
    if (!text) continue;
    lines.push(`${turn.role === "user" ? "**You:**" : "**Coach:**"} ${text}`);
    embeds.push(...embedsForCard(turn));
  }
  if (!lines.length) return [];
  const body = `${header}\n${lines.join("\n\n")}`;
  const parts = splitText(body, MAX_CONTENT - 20);
  const messages = parts.map((content) => ({ content, embeds: [] }));
  const unique = dedupeEmbeds(embeds).slice(0, MAX_EMBEDS);
  if (unique.length) messages[messages.length - 1].embeds = unique;
  return messages;
}

// ---------------------------------------------------------------------------
// Souls redaction

const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-f0-9]{40,}\b/gi,
];

export function redactSecrets(text, extraSecrets = []) {
  let out = String(text || "");
  for (const secret of extraSecrets) {
    const value = String(secret || "").trim();
    if (value.length >= 8) out = out.split(value).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(/^(\s*[\w.-]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY)[\w.-]*\s*[:=]\s*)\S.*$/gim, "$1[redacted]");
  out = out.replace(/(Bearer|Bot)\s+[A-Za-z0-9._~+/-]{16,}=*/g, "$1 [redacted]");
  return out;
}
