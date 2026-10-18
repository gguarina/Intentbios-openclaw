import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimUnmirrored,
  discordChannelFromSessionKey,
  embedsForCard,
  extractCard,
  isIntentbiosTool,
  mirrorMessages,
  postMessage,
  readMapping,
  recordThread,
  redactSecrets,
  threadForIntent,
} from "./discord-bridge.mjs";
import { createDiscordEmbedBridge } from "./index.js";

const FIG = "https://app.example/api/figures/figure.png?u=x&s=1";
const EQ = "https://app.example/api/figures/equation.png?l=YQ&s=2";
const card = {
  reply: "Look at $\\sin\\theta$.",
  discordText: "Look at sin θ.",
  summary: "s",
  deepLink: "https://app.example/x",
  suggestedReplies: [],
  intentId: "intent_abc_123",
  figures: [{ id: "n1:f1", title: "Unit circle", pngUrl: FIG }],
  equations: [{ latex: "a^2", pngUrl: EQ }],
};

test("session keys name the Discord thread; non-Discord sessions do not", () => {
  assert.equal(discordChannelFromSessionKey("agent:main:discord:channel:1560230058268827713"), "1560230058268827713");
  assert.equal(discordChannelFromSessionKey("agent:main:discord:channel:111111111111111111:thread:222222222222222222"), "222222222222222222");
  assert.equal(discordChannelFromSessionKey("agent:main:discord:direct:333333333333333333"), null);
  assert.equal(discordChannelFromSessionKey("agent:main:main"), null);
});

test("intentbios tools are recognised (plugin and MCP names)", () => {
  assert.ok(isIntentbiosTool("intentbios__journey_message"));
  assert.ok(isIntentbiosTool("coach_status"));
  assert.ok(!isIntentbiosTool("message"));
});

test("cards are found in MCP results and JSON text blocks", () => {
  assert.equal(extractCard({ content: [{ type: "text", text: JSON.stringify(card) }] }).intentId, card.intentId);
  assert.equal(extractCard({ structuredContent: card }).intentId, card.intentId);
  assert.equal(extractCard({ details: { output: card } }).intentId, card.intentId);
  assert.equal(extractCard({ content: [{ type: "text", text: "plain" }] }), null);
});

test("figures become titled image embeds; equations image embeds; http links dropped", () => {
  assert.deepEqual(embedsForCard(card), [{ title: "Unit circle", image: { url: FIG } }, { image: { url: EQ } }]);
  assert.deepEqual(embedsForCard({ figures: [{ title: "x", pngUrl: "http://insecure/x.png" }] }), []);
});

test("mapping store records threads and dedupes mirrored turns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-map-"));
  assert.equal(recordThread(dir, "intent_abc_123", "1234567890123456789"), true);
  assert.equal(recordThread(dir, "../evil", "1234567890123456789"), false);
  assert.equal(threadForIntent(dir, "intent_abc_123").threadId, "1234567890123456789");
  assert.deepEqual(claimUnmirrored(dir, "intent_abc_123", ["t1", "t2"]), ["t1", "t2"]);
  assert.deepEqual(claimUnmirrored(dir, "intent_abc_123", ["t2", "t3"]), ["t3"]);
  assert.equal(threadForIntent(dir, "nope"), null);
  assert.ok(readMapping(dir).intents.intent_abc_123.updatedAt);
});

test("mirror messages: marked from Ask, You/Coach lines, embeds on the last, under 2000 chars", () => {
  const msgs = mirrorMessages([
    { id: "u1", role: "user", text: "Why is sin²θ + cos²θ = 1?" },
    { id: "c1", role: "coach", text: "x".repeat(2500), figures: [{ title: "Unit circle", pngUrl: FIG }] },
  ]);
  assert.ok(msgs.length >= 2);
  assert.ok(msgs[0].content.startsWith("📱 **from Ask**\n**You:** Why is sin²θ"));
  assert.ok(msgs.every((m) => m.content.length <= 2000));
  assert.deepEqual(msgs.at(-1).embeds, [{ title: "Unit circle", image: { url: FIG } }]);
  assert.deepEqual(mirrorMessages([{ role: "user", text: "  " }]), []);
});

test("postMessage never pings and sends embeds", async () => {
  let seen;
  await postMessage("tok", "1234567890123456789", { content: "@everyone hi", embeds: [{ image: { url: FIG } }] }, async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  });
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(seen.url, "https://discord.com/api/v10/channels/1234567890123456789/messages");
  assert.equal(seen.init.headers.Authorization, "Bot tok");
});

test("embed bridge: posts card embeds after the reply in the same Discord session, once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-br-"));
  const posts = [];
  const bridge = createDiscordEmbedBridge({
    stateDir: dir,
    token: () => "tok",
    post: async (_t, channelId, body) => posts.push({ channelId, body }),
    settleMs: 5,
    fallbackMs: 10_000,
  });
  const sessionKey = "agent:main:discord:channel:1234567890123456789";
  bridge.afterToolCall({ toolName: "intentbios__coach_status", result: { structuredContent: card } }, { sessionKey });
  bridge.afterToolCall({ toolName: "intentbios__journey_message", result: { structuredContent: card } }, { sessionKey });
  bridge.afterToolCall({ toolName: "web_search", result: { structuredContent: card } }, { sessionKey });
  assert.equal(threadForIntent(dir, card.intentId).threadId, "1234567890123456789");
  bridge.messageSent({ to: "channel:1234567890123456789", success: true }, { sessionKey });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.embeds.length, 2);
  // Same figure again within 2 minutes: not reposted.
  bridge.afterToolCall({ toolName: "intentbios__journey_message", result: { structuredContent: card } }, { sessionKey });
  bridge.messageSent({ to: "channel:1234567890123456789", success: true }, {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posts.length, 1);
  for (const entry of bridge.pending.values()) clearTimeout(entry.fallback);
});

test("redaction removes tokens and secret assignments", () => {
  const text = "key sk-abcdefghijklmnopqrstuvwx\nDISCORD_BOT_TOKEN=abc.def\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nkeep this line";
  const out = redactSecrets(text, ["supersecretvalue"]);
  assert.ok(!out.includes("sk-abcdefghij"));
  assert.ok(out.includes("DISCORD_BOT_TOKEN=[redacted]"));
  assert.ok(out.includes("Bearer [redacted]"));
  assert.ok(out.includes("keep this line"));
  assert.equal(redactSecrets("a supersecretvalue b", ["supersecretvalue"]), "a [redacted] b");
});
