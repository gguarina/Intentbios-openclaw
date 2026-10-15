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
  assert.deepEqual(d.guilds["223456789012345678"], { requireMention: true, users: ["123456789012345678"] });
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
