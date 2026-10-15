// The Ash Cycle book framework (Phase 2): a second Discord bot account ("ash"), three agents,
// the ash-book plugin, channel-level routing, and knowledge files generated from the trilogy's
// `rewrite` branch via book-runner. Everything is gated on ASH_DISCORD_BOT_TOKEN; without it the
// config is returned unchanged, so the Intentbios setup is unaffected.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ASH_TOOL_NAMES, ASH_WRITE_TOOL_NAMES } from "../plugins/ash-book/client.mjs";

export const ASH_ACCOUNT_ID = "ash";
export const ASH_PLUGIN_ID = "ash-book";
export const ASH_TOKEN_ENV = "ASH_DISCORD_BOT_TOKEN";
export const ASH_AGENTS = {
  "ash-editor": {
    name: "Ash Editor",
    model: "deepseek/deepseek-v4-pro",
    tools: [...ASH_TOOL_NAMES, ...ASH_WRITE_TOOL_NAMES],
    knowledge: true,
  },
  "ash-coldreader": {
    name: "Ash Cold Reader",
    model: "deepseek/deepseek-v4-flash",
    tools: ["book_chapters", "book_chapter"],
    knowledge: false,
  },
  "ash-continuity": {
    name: "Ash Continuity",
    model: "deepseek/deepseek-v4-flash",
    tools: ["book_grep", "book_chapter", "book_chapters", "book_file", "book_branches"],
    knowledge: true,
  },
};
// Channel key -> agent. Unlisted traffic on the ash account (DMs, other channels) goes to ash-editor.
export const ASH_CHANNEL_AGENTS = {
  desk: "ash-editor",
  briefs: "ash-editor",
  builds: "ash-editor",
  coldreads: "ash-coldreader",
  continuity: "ash-continuity",
};

const pluginDir = fileURLToPath(new URL("../plugins/ash-book/", import.meta.url));
const templatesDir = path.join(pluginDir, "workspaces");

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ids = (raw) => String(raw || "").split(/[\s,]+/).map((v) => v.trim()).filter((v) => /^\d{5,30}$/.test(v));
const union = (a, b) => Array.from(new Set([...(Array.isArray(a) ? a : []), ...b]));

/** "desk:123,builds:456" -> { desk: "123", builds: "456" } */
export function parseAshChannels(raw) {
  const out = {};
  for (const part of String(raw || "").split(/[\s,]+/)) {
    const m = part.match(/^([a-z-]+)[:=](\d{5,30})$/);
    if (m) out[m[1].replace(/^ash-/, "")] = m[2];
  }
  return out;
}

export function ashWorkspaceDir(stateDir, agentId) {
  return path.join(stateDir, "workspaces", agentId);
}

export function mergeAshBookConfig(config, env = process.env, { stateDir = "/data/.openclaw" } = {}) {
  if (!isObj(config)) throw new Error("mergeAshBookConfig requires a config object");
  if (!String(env[ASH_TOKEN_ENV] || "").trim()) return config;
  const guildId = ids(env.ASH_DISCORD_GUILD_ID)[0];
  const channels = parseAshChannels(env.ASH_DISCORD_CHANNELS);
  const users = ids(env.ASH_DISCORD_ALLOWED_USER_IDS || env.DISCORD_ALLOWED_USER_IDS);
  if (!guildId || users.length === 0) return config; // never run the bot unrestricted

  const merged = { ...config };

  // Plugin
  const plugins = isObj(config.plugins) ? { ...config.plugins } : {};
  plugins.enabled = true;
  const load = isObj(plugins.load) ? { ...plugins.load } : {};
  const pPath = pluginDir.replace(/\/$/, "");
  load.paths = (Array.isArray(load.paths) ? load.paths : []).some((p) => path.resolve(p) === path.resolve(pPath))
    ? load.paths
    : [...(load.paths || []), pPath];
  plugins.load = load;
  if (Array.isArray(plugins.allow)) plugins.allow = union(plugins.allow, [ASH_PLUGIN_ID]);
  if (Array.isArray(plugins.deny)) plugins.deny = plugins.deny.filter((p) => p !== ASH_PLUGIN_ID);
  const pEntries = isObj(plugins.entries) ? { ...plugins.entries } : {};
  pEntries[ASH_PLUGIN_ID] = {
    enabled: true,
    config: {
      runnerUrl: String(env.BOOK_RUNNER_URL || "").trim(),
      ...(channels.builds ? { buildsChannelId: channels.builds } : {}),
      defaultBranch: "rewrite",
    },
  };
  plugins.entries = pEntries;
  merged.plugins = plugins;

  // Agents (others untouched)
  const agents = isObj(config.agents) ? { ...config.agents } : {};
  const entries = isObj(agents.entries) ? { ...agents.entries } : {};
  for (const [id, spec] of Object.entries(ASH_AGENTS)) {
    const cur = isObj(entries[id]) ? { ...entries[id] } : {};
    entries[id] = {
      ...cur,
      name: spec.name,
      workspace: ashWorkspaceDir(stateDir, id),
      model: spec.model,
      identity: { name: "Ash" },
      tools: { profile: "full", allow: [...spec.tools] },
      subagents: { allowAgents: [] },
    };
  }
  agents.entries = entries;
  merged.agents = agents;

  // Discord: second account, restricted to the Ash channels and the allowed user(s).
  const ch = isObj(config.channels) ? { ...config.channels } : {};
  const discord = isObj(ch.discord) ? { ...ch.discord } : { enabled: true };
  const accounts = isObj(discord.accounts) ? { ...discord.accounts } : {};
  const chanMap = {};
  for (const id of Object.values(channels)) chanMap[id] = { enabled: true, requireMention: false, users };
  accounts[ASH_ACCOUNT_ID] = {
    name: "Ash",
    enabled: true,
    token: { source: "env", provider: "default", id: ASH_TOKEN_ENV },
    dmPolicy: "allowlist",
    allowFrom: users,
    groupPolicy: "allowlist",
    allowBots: false,
    configWrites: false,
    actions: { messages: true, threads: true, channels: false, roles: false, moderation: false },
    guilds: { [guildId]: { requireMention: false, users, channels: chanMap } },
  };
  discord.accounts = accounts;
  ch.discord = discord;
  merged.channels = ch;

  // Bindings: drop our old ones, then exact channel peers (threads inherit via parent peer),
  // then an ash-account fallback. Bindings for other accounts are kept as they are.
  const keep = (Array.isArray(config.bindings) ? config.bindings : []).filter(
    (b) => !(b?.match?.channel === "discord" && b?.match?.accountId === ASH_ACCOUNT_ID),
  );
  const ours = [];
  for (const [key, agentId] of Object.entries(ASH_CHANNEL_AGENTS)) {
    if (!channels[key]) continue;
    ours.push({ agentId, match: { channel: "discord", accountId: ASH_ACCOUNT_ID, peer: { kind: "channel", id: channels[key] } } });
  }
  ours.push({ agentId: "ash-editor", match: { channel: "discord", accountId: ASH_ACCOUNT_ID } });
  merged.bindings = [...keep, ...ours];
  return merged;
}

/** Copy templates into each agent workspace. */
export function writeAshWorkspaces(stateDir) {
  const out = [];
  for (const id of Object.keys(ASH_AGENTS)) {
    const dir = ashWorkspaceDir(stateDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(templatesDir, id);
    for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dir, name));
    out.push(dir);
  }
  return out;
}

function section(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function buildKnowledge({ bible, volumes = {}, locksScript = "", baseline = "", characters = "", sha = "" }) {
  const stamp = `<!-- generated from gustavo-guarin/agi-war-trilogy@rewrite ${sha} on boot; do not edit -->\n\n`;
  const voice = [
    "# Voice rules (extracted from the series bible)",
    section(bible, "## Style and voice"),
    section(bible, "## Canonical lines"),
    section(bible, "## The phrase \"I do not know if\""),
    section(bible, "## Banned names and banned prose"),
    section(bible, "## Repetition audit"),
    "## Known tics from the last cold reads (avoid)",
    "- The \"I don't know X. I know Y\" / \"I know the [concrete noun]\" wisdom move from working people.",
    "- Dash-hedges in crisp characters' speech (e.g. Naomi).",
    "- Mira's word-retrieval formula (\"She found the word and spent it\").",
    "- Aphoristic inversions in AI voices (\"gifts from an adversary are invoices\").",
    "- Slash-list notes from every note-taker.",
  ].filter(Boolean).join("\n\n");
  const locks = [
    "# Locks",
    "`tools/locks.sh` on the `rewrite` branch runs these grep checks. It exits 1 when its output differs from `prompts/locks-baseline-rewrite.txt`. Locks gate commits (Phase 3).",
    "## Script", "```bash", locksScript.trim(), "```",
    "## Passing baseline", "```", baseline.trim(), "```",
  ].join("\n\n");
  const files = { "BIBLE.md": bible, "VOICE.md": voice, "LOCKS.md": locks, "CHARACTERS.md": characters };
  for (const [n, t] of Object.entries(volumes)) files[`VOLUME-0${n}.md`] = t;
  return Object.fromEntries(Object.entries(files).filter(([, t]) => t).map(([n, t]) => [n, stamp + t]));
}

/** Fetch knowledge from book-runner and write it to the knowledge-bearing agents. Keeps old files on failure. */
export async function syncAshKnowledge(stateDir, env = process.env, fetchImpl = fetch) {
  const base = String(env.BOOK_RUNNER_URL || "").trim().replace(/\/$/, "");
  const token = String(env.BOOK_RUNNER_TOKEN || "").trim();
  if (!base || !token) return { ok: false, reason: "BOOK_RUNNER_URL/BOOK_RUNNER_TOKEN unset" };
  const get = async (p) => {
    const r = await fetchImpl(`${base}/file?branch=rewrite&path=${encodeURIComponent(p)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.text();
  };
  const opt = (p) => get(p).catch(() => "");
  const bible = await get("prompts/series-bible.md");
  const [v1, v2, v3, locksScript, baseline, characters] = await Promise.all([
    opt("prompts/volume-01-the-agi-war.md"),
    opt("prompts/volume-02-the-resonance-war.md"),
    opt("prompts/volume-03-the-cosmic-synthesis.md"),
    opt("tools/locks.sh"),
    opt("prompts/locks-baseline-rewrite.txt"),
    opt("canon/characters.md"),
  ]);
  const files = buildKnowledge({ bible, volumes: { 1: v1, 2: v2, 3: v3 }, locksScript, baseline, characters });
  const written = [];
  for (const [id, spec] of Object.entries(ASH_AGENTS)) {
    if (!spec.knowledge) continue;
    const dir = ashWorkspaceDir(stateDir, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), text, "utf8");
      written.push(`${id}/${name}`);
    }
  }
  return { ok: true, written };
}
