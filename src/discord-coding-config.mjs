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
  if (next.configWrites === undefined) next.configWrites = false;

  if (guildIds.length > 0) {
    const guilds = isPlainObject(next.guilds) ? { ...next.guilds } : {};
    for (const id of guildIds) {
      const g = isPlainObject(guilds[id]) ? { ...guilds[id] } : {};
      if (g.requireMention === undefined) g.requireMention = true;
      if (userIds.length > 0) {
        g.users = Array.from(new Set([...(Array.isArray(g.users) ? g.users : []), ...userIds]));
      }
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
