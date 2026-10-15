import test from "node:test";
import assert from "node:assert/strict";
import { mergeAshBookConfig, parseAshChannels, buildKnowledge } from "./ash-book-config.mjs";

const base = () => ({
  agents: { ownership: "explicit", entries: { main: { name: "main" }, "intentbios-coach": { name: "Coach" } } },
  bindings: [{ agentId: "main", match: { channel: "discord", accountId: "default" } }],
  channels: { discord: { enabled: true, token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" }, guilds: { 1: { requireMention: false } } } },
  plugins: { load: { paths: ["/app/plugins/intentbios"] }, entries: { intentbios: { enabled: true } } },
});
const env = {
  ASH_DISCORD_BOT_TOKEN: "t",
  ASH_DISCORD_GUILD_ID: "1560189547013341277",
  ASH_DISCORD_CHANNELS: "desk:111111,continuity:222222,builds:333333",
  DISCORD_ALLOWED_USER_IDS: "1560179504196886610",
  BOOK_RUNNER_URL: "https://runner",
};

test("no Ash token leaves config untouched", () => {
  const c = base();
  assert.equal(mergeAshBookConfig(c, {}), c);
});

test("no allowlisted user leaves config untouched", () => {
  const c = base();
  assert.equal(mergeAshBookConfig(c, { ...env, DISCORD_ALLOWED_USER_IDS: "" }), c);
});

test("merge keeps Intentbios intact and adds routed Ash account", () => {
  const c = base();
  const before = JSON.stringify(c);
  const m = mergeAshBookConfig(c, env);
  assert.equal(JSON.stringify(c), before, "input not mutated");
  assert.deepEqual(m.bindings[0], c.bindings[0]);
  assert.deepEqual(m.agents.entries.main, c.agents.entries.main);
  assert.deepEqual(m.agents.entries["intentbios-coach"], c.agents.entries["intentbios-coach"]);
  assert.equal(m.channels.discord.token.id, "DISCORD_BOT_TOKEN");
  assert.deepEqual(m.channels.discord.guilds, c.channels.discord.guilds);
  const ash = m.channels.discord.accounts.ash;
  assert.equal(ash.token.id, "ASH_DISCORD_BOT_TOKEN");
  assert.deepEqual(Object.keys(ash.guilds["1560189547013341277"].channels).sort(), ["111111", "222222", "333333"]);
  const cont = m.bindings.find((b) => b.match.peer?.id === "222222");
  assert.equal(cont.agentId, "ash-continuity");
  assert.equal(cont.match.accountId, "ash");
  assert.equal(m.bindings.at(-1).agentId, "ash-editor");
  assert.equal(m.plugins.entries["ash-book"].config.buildsChannelId, "333333");
  assert.ok(m.plugins.load.paths.some((p) => p.endsWith("plugins/ash-book")));
  assert.deepEqual(m.agents.entries["ash-coldreader"].tools.allow, ["book_chapters", "book_chapter"]);
  assert.ok(m.agents.entries["ash-editor"].tools.allow.includes("work_commit"));
  assert.ok(!m.agents.entries["ash-continuity"].tools.allow.some((t) => t.startsWith("work_")));
});

test("merge is idempotent", () => {
  const once = mergeAshBookConfig(base(), env);
  assert.deepEqual(mergeAshBookConfig(once, env), once);
});

test("parseAshChannels and knowledge", () => {
  assert.deepEqual(parseAshChannels("ash-desk:123456, builds=654321"), { desk: "123456", builds: "654321" });
  const k = buildKnowledge({ bible: "# B\n\n## Style and voice\nSV\n\n## Canonical lines\n- x\n\n## Other\nno", baseline: "b" });
  assert.match(k["VOICE.md"], /SV/);
  assert.doesNotMatch(k["VOICE.md"], /## Other/);
  assert.ok(k["BIBLE.md"] && k["LOCKS.md"]);
});
