import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeDiscordConfig, writeCodingSkills } from "./discord-coding-config.mjs";

test("no token leaves config unchanged", () => {
  const c = { a: 1 };
  assert.equal(mergeDiscordConfig(c, {}), c);
});

test("enables discord with env SecretRef, pairing DMs, allowlist guilds", () => {
  const out = mergeDiscordConfig({ plugins: { allow: ["intentbios"] } }, { DISCORD_BOT_TOKEN: "x" });
  const d = out.channels.discord;
  assert.deepEqual(d.token, { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" });
  assert.equal(d.dmPolicy, "pairing");
  assert.equal(d.groupPolicy, "allowlist");
  assert.equal(d.allowBots, false);
  assert.ok(out.plugins.allow.includes("discord"));
  assert.ok(!JSON.stringify(out).includes('"x"'));
});

test("tightens open policies and applies user/guild allowlists", () => {
  const out = mergeDiscordConfig(
    { channels: { discord: { token: "keep", dmPolicy: "open", groupPolicy: "open", dm: { policy: "open" } } } },
    { DISCORD_BOT_TOKEN: "x", DISCORD_ALLOWED_USER_IDS: "123456789012345678", DISCORD_GUILD_ID: "223456789012345678" },
  );
  const d = out.channels.discord;
  assert.equal(d.token, "keep");
  assert.equal(d.dmPolicy, "allowlist");
  assert.deepEqual(d.allowFrom, ["123456789012345678"]);
  assert.equal(d.dm.policy, "allowlist");
  assert.equal(d.groupPolicy, "allowlist");
  const gg = d.guilds["223456789012345678"];
  assert.equal(gg.requireMention, false);
  assert.deepEqual(gg.users, ["123456789012345678"]);
  assert.deepEqual(gg.channels["*"], { enabled: true, requireMention: false, users: ["123456789012345678"] });
  assert.equal(gg.channels["1560230058268827713"].requireMention, false);
  assert.match(gg.channels["1560230058268827713"].systemPrompt, /#intents/);
  const g = mergeDiscordConfig({}, { DISCORD_BOT_TOKEN: "x", DISCORD_GUILD_ID: "223456789012345678" }).channels.discord.guilds["223456789012345678"];
  assert.equal(g.requireMention, true);
  assert.deepEqual(g.channels["*"], { enabled: true, requireMention: true });
});

test("is idempotent", () => {
  const env = { DISCORD_BOT_TOKEN: "x" };
  const once = mergeDiscordConfig({}, env);
  assert.deepEqual(mergeDiscordConfig(once, env), once);
});

test("writes coding skill into workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  writeCodingSkills(dir);
  assert.ok(fs.existsSync(path.join(dir, "skills", "github-coding", "SKILL.md")));
});

test("binds discord:default to main when multiple agents exist", () => {
  const cfg = { agents: { entries: { main: { default: true }, "intentbios-coach": {}, "intentbios-sophia": {} } } };
  const out = mergeDiscordConfig(cfg, { DISCORD_BOT_TOKEN: "x" });
  assert.deepEqual(out.bindings, [{ agentId: "main", match: { channel: "discord", accountId: "default" } }]);
  assert.deepEqual(mergeDiscordConfig(out, { DISCORD_BOT_TOKEN: "x" }).bindings, out.bindings);
});

test("keeps an existing discord binding", () => {
  const cfg = { bindings: [{ agentId: "x", match: { channel: "discord" } }] };
  assert.deepEqual(mergeDiscordConfig(cfg, { DISCORD_BOT_TOKEN: "x" }).bindings, cfg.bindings);
});

import { mergeIntentbiosMcp } from "./discord-coding-config.mjs";
test("registers intentbios MCP server", () => {
  const out = mergeIntentbiosMcp({}, { INTENTBIOS_API_URL: "https://coach.example/" });
  assert.deepEqual(out.mcp.servers.intentbios, {
    url: "https://coach.example/mcp", transport: "streamable-http",
    headers: { "x-user-id": "gustavo" }, connectionTimeoutMs: 15000, requestTimeoutMs: 120000,
  });
  assert.deepEqual(mergeIntentbiosMcp(out, { INTENTBIOS_API_URL: "https://coach.example/" }), out);
  assert.deepEqual(mergeIntentbiosMcp({ a: 1 }, {}), { a: 1 });
});

test("intents prompt asks the tool to write as the linked account", () => {
  const gg = mergeDiscordConfig({}, { DISCORD_BOT_TOKEN: "x", DISCORD_GUILD_ID: "223456789012345678" })
    .channels.discord.guilds["223456789012345678"];
  const prompt = gg.channels["1560230058268827713"].systemPrompt;
  assert.match(prompt, /linked Intentbios account/);
  assert.ok(!prompt.includes("user gustavo"));
});

test("adds MCP Authorization header by env reference only", () => {
  const out = mergeIntentbiosMcp({}, { INTENTBIOS_API_URL: "https://c.example", INTENTBIOS_MCP_API_KEY: "secret-value" });
  assert.equal(out.mcp.servers.intentbios.headers.Authorization, "Bearer ${INTENTBIOS_MCP_API_KEY}");
  assert.ok(!JSON.stringify(out).includes("secret-value"));
  const off = mergeIntentbiosMcp(out, { INTENTBIOS_API_URL: "https://c.example" });
  assert.equal(off.mcp.servers.intentbios.headers.Authorization, undefined);
});

import { upsertKnowledgeBlock, writeKnowledge } from "./discord-coding-config.mjs";
test("knowledge block upsert keeps user text and is idempotent", () => {
  const once = upsertKnowledgeBlock("# Mine\nkeep me\n", "A");
  assert.ok(once.startsWith("# Mine\nkeep me"));
  const twice = upsertKnowledgeBlock(once, "B");
  assert.ok(twice.includes("B") && !twice.includes("\nA\n") && twice.includes("keep me"));
  assert.equal(upsertKnowledgeBlock(twice, "B"), twice);
});
test("writeKnowledge creates AGENTS.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
  const f = writeKnowledge(dir);
  assert.match(fs.readFileSync(f, "utf8"), /intent_muz6fi39_0m1qa2/);
});
