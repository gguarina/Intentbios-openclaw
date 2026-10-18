import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DISCORD_TOKEN_ENV = "DISCORD_BOT_TOKEN";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseIdList(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => /^\d{5,30}$/.test(v));
}

/**
 * Enable channels.discord with the token read from DISCORD_BOT_TOKEN (env SecretRef).
 * Never writes the token itself into openclaw.json.
 *
 * Access model (the bot can push to GitHub, so strangers must not drive it):
 * - DMs: "pairing" by default. Unknown users get a code that must be approved
 *   (setup page "Approve pairing" or `openclaw pairing approve discord <CODE>`).
 *   With DISCORD_ALLOWED_USER_IDS set, DMs switch to "allowlist" for those IDs.
 * - Guild channels: "allowlist". No guild answers until DISCORD_GUILD_ID is set;
 *   then only that guild, only on @mention, and only from allowed user IDs.
 * - Other bots are ignored; config writes from chat are disabled.
 */
export const INTENTS_CHANNEL_ID = "1560230058268827713";
export const INTENTS_PROMPT = [
  "This is #intents: act as Gustavo's Intentbios coach here, not as a coder.",
  "New goal -> create it with intentbios__intent_create, then coach it with intentbios__journey_message; these write as the requester's linked Intentbios account, so never pass or assume a user id.",
  "If the intent_create card has introPending: true, its reply is only a holding line: post it, then call intentbios__coach_status with that intentId and post its reply (the coach's introduction: the plan and the first move) as the next message in the same thread. Never end the turn on the holding line alone.",
  "Post a card's discordText when it has one (math already converted for Discord), else its reply. Figures and equations are posted as embeds by the bot right after your message: never add MEDIA lines, image links or LaTeX yourself.",
  "A thread opened from Ask names its intent id in its first message: continue that intent. Bot messages marked \"📱 from Ask\" are the same conversation typed in the Ask app.",
  "Follow-ups in the same thread continue that intent. One step at a time, short replies, suggest 2-3 example answers when a condition is missing,",
  "never invent listings or facts, always include the step deepLink. No code changes or PRs from this channel; send coding asks to #dev.",
].join(" ");

export function mergeDiscordConfig(config, env = process.env) {
  if (!isPlainObject(config)) throw new Error("mergeDiscordConfig requires a config object");
  if (!String(env[DISCORD_TOKEN_ENV] || "").trim()) return config;

  const channels = isPlainObject(config.channels) ? { ...config.channels } : {};
  const current = isPlainObject(channels.discord) ? { ...channels.discord } : {};
  const userIds = parseIdList(env.DISCORD_ALLOWED_USER_IDS);
  const guildIds = parseIdList(env.DISCORD_GUILD_ID);

  const next = { ...current };
  next.enabled = true;
  if (typeof next.token !== "string" || !next.token.trim()) {
    next.token = { source: "env", provider: "default", id: DISCORD_TOKEN_ENV };
  }
  if (userIds.length > 0) {
    next.dmPolicy = "allowlist";
    next.allowFrom = Array.from(new Set([...(Array.isArray(next.allowFrom) ? next.allowFrom : []), ...userIds]));
  } else if (!next.dmPolicy || next.dmPolicy === "open") {
    next.dmPolicy = "pairing";
  }
  if (isPlainObject(next.dm) && next.dm.policy === "open") {
    next.dm = { ...next.dm, policy: next.dmPolicy };
  }
  if (!next.groupPolicy || next.groupPolicy === "open") next.groupPolicy = "allowlist";
  if (next.allowBots === undefined) next.allowBots = false;
  // Workflow needs threads + channel creation in Gustavo's server; moderation/roles stay off.
  // Thread/forum-post deletion has no gate of its own in @openclaw/discord: it is `channel-delete` on the
  // thread id, gated by `channels` (the narrowest setting). Who may ask for it is a knowledge rule.
  next.actions = { ...(isPlainObject(next.actions) ? next.actions : {}), messages: true, threads: true, channels: true, roles: false, moderation: false };
  if (next.configWrites === undefined) next.configWrites = false;

  if (guildIds.length > 0) {
    const guilds = isPlainObject(next.guilds) ? { ...next.guilds } : {};
    for (const id of guildIds) {
      const g = isPlainObject(guilds[id]) ? { ...guilds[id] } : {};
      // Until Gustavo's user ID is allowlisted, anyone in the guild could talk to the bot:
      // require an @mention. With DISCORD_ALLOWED_USER_IDS set, only he can, so no mention needed.
      g.requireMention = userIds.length === 0;
      if (userIds.length > 0) {
        g.users = Array.from(new Set([...(Array.isArray(g.users) ? g.users : []), ...userIds]));
      }
      // Explicit channel map: "*" keeps every channel (incl. threads and forum posts, which inherit
      // their parent) open to the allowed users; #intents additionally gets the coach behavior.
      const chans = isPlainObject(g.channels) ? { ...g.channels } : {};
      const base = { enabled: true, requireMention: g.requireMention, ...(g.users ? { users: g.users } : {}) };
      chans["*"] = { ...(isPlainObject(chans["*"]) ? chans["*"] : {}), ...base };
      const intentsId = parseIdList(env.DISCORD_INTENTS_CHANNEL_ID || INTENTS_CHANNEL_ID)[0];
      if (intentsId) {
        chans[intentsId] = { ...(isPlainObject(chans[intentsId]) ? chans[intentsId] : {}), ...base, systemPrompt: INTENTS_PROMPT };
      }
      g.channels = chans;
      guilds[id] = g;
    }
    next.guilds = guilds;
  }

  channels.discord = next;
  const merged = { ...config, channels };

  // With several agents (main + intentbios-coach + intentbios-sophia) OpenClaw refuses to
  // guess who owns Discord. Bind discord:default to the general agent unless a binding exists.
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const hasDiscordBinding = bindings.some(
    (b) => b?.match?.channel === "discord" && !b?.match?.peer && (!b?.match?.accountId || b.match.accountId === "default"),
  );
  if (!hasDiscordBinding) {
    const agentId = pickDiscordAgent(config, env);
    if (agentId) {
      merged.bindings = [...bindings, { agentId, match: { channel: "discord", accountId: "default" } }];
    }
  }

  if (isPlainObject(config.plugins)) {
    const plugins = { ...config.plugins };
    if (Array.isArray(plugins.allow) && !plugins.allow.includes("discord")) {
      plugins.allow = [...plugins.allow, "discord"];
    }
    if (Array.isArray(plugins.deny)) plugins.deny = plugins.deny.filter((p) => p !== "discord");
    merged.plugins = plugins;
  }
  return merged;
}

export function pickDiscordAgent(config, env = process.env) {
  const ids = Object.keys(isPlainObject(config?.agents?.entries) ? config.agents.entries : {});
  const wanted = String(env.DISCORD_AGENT_ID || "").trim();
  if (wanted) return wanted;
  if (ids.length === 0 || ids.includes("main")) return "main";
  const entries = config.agents.entries;
  const def = ids.find((id) => entries[id]?.default === true && !id.startsWith("intentbios-"));
  return def || ids.find((id) => !id.startsWith("intentbios-")) || null;
}

const codingSkillDir = fileURLToPath(new URL("../plugins/coding-skill/", import.meta.url));

/** Copy the bundled coding skill(s) into <workspace>/skills/. Overwrites on each boot. */
export function writeCodingSkills(workspaceDir) {
  if (!workspaceDir) throw new Error("writeCodingSkills requires workspaceDir");
  const dest = path.join(workspaceDir, "skills");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(codingSkillDir, dest, { recursive: true, force: true });
  return dest;
}

/**
 * Register the Intentbios MCP connector (POST <INTENTBIOS_API_URL>/mcp) as mcp.servers.intentbios.
 * Tools surface as intentbios__<tool>. x-user-id defaults to "gustavo" (INTENTBIOS_MCP_USER_ID).
 */
export function mergeIntentbiosMcp(config, env = process.env) {
  if (!isPlainObject(config)) throw new Error("mergeIntentbiosMcp requires a config object");
  const base = String(env.INTENTBIOS_MCP_URL || env.INTENTBIOS_API_URL || "").trim().replace(/\/+$/, "");
  if (!base) return config;
  const url = env.INTENTBIOS_MCP_URL ? base : `${base}/mcp`;
  const userId = String(env.INTENTBIOS_MCP_USER_ID || "gustavo").trim();
  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};
  const servers = isPlainObject(mcp.servers) ? { ...mcp.servers } : {};
  const current = isPlainObject(servers.intentbios) ? servers.intentbios : {};
  const headers = { ...(isPlainObject(current.headers) ? current.headers : {}), "x-user-id": userId };
  // Key referenced by env var name only; OpenClaw expands ${VAR} in config strings at load.
  if (String(env.INTENTBIOS_MCP_API_KEY || "").trim()) {
    headers.Authorization = "Bearer ${INTENTBIOS_MCP_API_KEY}";
  } else {
    delete headers.Authorization;
  }
  servers.intentbios = {
    ...current,
    url,
    transport: "streamable-http",
    headers,
    connectionTimeoutMs: current.connectionTimeoutMs ?? 15000,
    requestTimeoutMs: current.requestTimeoutMs ?? 120000,
  };
  mcp.servers = servers;
  return { ...config, mcp };
}

const knowledgeFile = fileURLToPath(new URL("../plugins/main-knowledge/INTENTBIOS.md", import.meta.url));
export const KNOWLEDGE_BEGIN = "<!-- intentbios-knowledge:begin -->";
export const KNOWLEDGE_END = "<!-- intentbios-knowledge:end -->";

/** Insert or replace the managed Intentbios block in text (AGENTS.md); keeps the rest intact. */
export function upsertKnowledgeBlock(text, block) {
  const managed = `${KNOWLEDGE_BEGIN}\n${block.trim()}\n${KNOWLEDGE_END}`;
  const src = String(text || "");
  const start = src.indexOf(KNOWLEDGE_BEGIN);
  const end = src.indexOf(KNOWLEDGE_END);
  if (start >= 0 && end > start) {
    return src.slice(0, start) + managed + src.slice(end + KNOWLEDGE_END.length);
  }
  return src.trim() ? `${src.replace(/\s+$/, "")}\n\n${managed}\n` : `${managed}\n`;
}

/** Write the Intentbios knowledge block into <workspace>/AGENTS.md (loaded every session). */
export function writeKnowledge(workspaceDir) {
  const target = path.join(workspaceDir, "AGENTS.md");
  const block = fs.readFileSync(knowledgeFile, "utf8");
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const next = upsertKnowledgeBlock(current, block);
  if (next !== current) fs.writeFileSync(target, next, "utf8");
  return target;
}
