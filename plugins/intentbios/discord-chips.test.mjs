import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LABEL,
  allowedChipUsers,
  chipComponentsSpec,
  chipLabel,
  chipSkipReason,
  disableChipsOnMessage,
  disabledChipComponents,
  suggestedRepliesFromCard,
  withChips,
} from "./discord-chips.mjs";
import { createDiscordChipBridge } from "./index.js";

const OWNER = "1560179504196886610";
const THREAD = "1561297516228648994";
const SESSION = `agent:main:discord:channel:${THREAD}`;

const mcpResult = (card) => ({ content: [{ type: "text", text: JSON.stringify(card) }] });
const card = {
  reply: "Place 90° on the unit circle.",
  summary: "Unit circle",
  deepLink: "https://app.example/?intentId=intent_mvdkol18_xtnuyd&node=n2",
  intentId: "intent_mvdkol18_xtnuyd",
  suggestedReplies: ["It lands at (0, 1).", "What should I do on this step?", "I'm stuck"],
};

test("labels stay ≤ 80 chars, cut at a word boundary with an ellipsis", () => {
  assert.equal(chipLabel("  I'm   stuck "), "I'm stuck");
  const long = "Could you explain once more why the sine of an angle is the y coordinate on the unit circle please";
  const label = chipLabel(long);
  assert.ok(label.length <= MAX_LABEL, label);
  assert.ok(label.endsWith("…"));
  assert.ok(long.startsWith(label.slice(0, -1)), "a prefix of the reply");
  assert.ok(!/\s…$/.test(label) && long[label.length - 1] === " ", "cut falls on a word boundary");
  const word = "x".repeat(120);
  assert.equal(chipLabel(word).length, MAX_LABEL);
});

test("suggested replies: flat or nested coachCard, deduped, max 5", () => {
  assert.deepEqual(suggestedRepliesFromCard(card), card.suggestedReplies);
  assert.deepEqual(suggestedRepliesFromCard({ reply: "r", coachCard: { suggestedReplies: ["a", "A", " ", "b"] } }), ["a", "b"]);
  assert.equal(suggestedRepliesFromCard({ suggestedReplies: ["1", "2", "3", "4", "5", "6", "7"] }).length, 5);
  assert.deepEqual(suggestedRepliesFromCard({}), []);
});

test("spec: secondary buttons in rows of 5, full reply as callbackData, owner-only", () => {
  const long = "Could you explain once more why the sine of an angle is the y coordinate on the unit circle please";
  const spec = chipComponentsSpec(["a", "b", "c", "d", "e", long].slice(0, 6), { allowedUsers: [OWNER] });
  assert.equal(spec.reusable, false);
  assert.equal(spec.blocks.length, 1, "5 chips max → one row");
  assert.equal(spec.blocks[0].type, "actions");
  assert.equal(spec.blocks[0].buttons.length, 5);
  for (const b of spec.blocks[0].buttons) {
    assert.equal(b.style, "secondary");
    assert.deepEqual(b.allowedUsers, [OWNER]);
    assert.equal(b.callbackDataKind, undefined, "no kind: the press is routed as the user's message");
  }
  const one = chipComponentsSpec([long], { allowedUsers: [OWNER] }).blocks[0].buttons[0];
  assert.equal(one.callbackData, long);
  assert.ok(one.label.length <= 80);
  assert.deepEqual(allowedChipUsers(""), [OWNER]);
  assert.deepEqual(allowedChipUsers("111111111111111111, 222222222222222222"), ["111111111111111111", "222222222222222222"]);
});

test("payloads that cannot carry chips keep their shape", () => {
  assert.equal(chipSkipReason({ text: "Hi" }), null);
  assert.equal(chipSkipReason({ text: "" }), "no text");
  assert.equal(chipSkipReason({ text: "x".repeat(1901) }), "reply too long");
  assert.equal(chipSkipReason({ text: "Hi", mediaUrls: ["https://x/y.png"] }), "has media");
  assert.equal(chipSkipReason({ text: "Hi", isReasoning: true }), "not a reply");
  assert.equal(chipSkipReason({ text: "Hi", channelData: { discord: { components: {} } } }), "already rich");
  const out = withChips({ text: "Hi", channelData: { other: 1 } }, ["a"], { allowedUsers: [OWNER] });
  assert.equal(out.text, "Hi");
  assert.equal(out.channelData.other, 1);
  assert.equal(out.channelData.discord.components.blocks[0].buttons[0].callbackData, "a");
});

// The Discord message as the API returns it (components v2: container → text, row → buttons).
const v2Message = (id) => ({
  id,
  author: { id: "1560186289704402986", bot: true },
  components: [{
    type: 17,
    components: [
      { type: 10, content: "Place 90° on the unit circle." },
      { type: 1, components: card.suggestedReplies.map((label, i) => ({ type: 2, style: 2, label, custom_id: `occomp:cid=btn_${i}` })) },
    ],
  }],
});

test("disabling flips every chip off and marks the pressed one green; text untouched", () => {
  const next = disabledChipComponents(v2Message("1").components, "It lands at (0, 1).");
  const row = next[0].components[1].components;
  assert.ok(row.every((b) => b.disabled === true));
  assert.equal(row[0].style, 3);
  assert.equal(row[1].style, 2);
  assert.equal(next[0].components[0].content, "Place 90° on the unit circle.");
  assert.equal(disabledChipComponents(next, ""), null, "already disabled → nothing to do");
});

test("disableChipsOnMessage PATCHes components; finds the message by labels without an id", async () => {
  const calls = [];
  const request = async (_token, method, route, body) => {
    calls.push({ method, route, body });
    if (method === "GET" && route.includes("?limit=")) return [{ id: "9", author: { bot: false }, components: [] }, v2Message("1561300000000000001")];
    if (method === "GET") return v2Message("1561300000000000002");
    return {};
  };
  const byId = await disableChipsOnMessage({ token: "t", channelId: THREAD, messageId: "1561300000000000002", request });
  assert.deepEqual(byId, { ok: true, messageId: "1561300000000000002", changed: true });
  const byLabel = await disableChipsOnMessage({ token: "t", channelId: THREAD, labels: ["I'm stuck"], request });
  assert.equal(byLabel.messageId, "1561300000000000001");
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.ok(patches[0].body.components[0].components[1].components.every((b) => b.disabled));
});

/**
 * End to end through the bridge, with the Discord plugin's own click path simulated:
 * coach tool result → reply payload gets chips → message sent → a press
 * (the plugin routes the button's callbackData into the session as an inbound
 * message) → that text goes to the coach for the same intent → the chips are disabled.
 */
test("chip lifecycle: attach on the coach reply, press routes the reply to the coach, chips disabled", async () => {
  const disabled = [];
  const bridge = createDiscordChipBridge({
    token: () => "bot-token",
    allowedUsers: () => [OWNER],
    disable: async (args) => { disabled.push(args); return { ok: true, changed: true, messageId: args.messageId }; },
  });
  const ctx = { sessionKey: SESSION };

  // 1. The coach tool returns its card in the intent thread's session.
  bridge.afterToolCall({ toolName: "intentbios__journey_message", params: { intentId: card.intentId }, result: mcpResult(card) }, ctx);
  // Non-final (streamed block) payloads are left alone.
  assert.equal(bridge.replyPayloadSending({ kind: "block", payload: { text: "…" }, sessionKey: SESSION, channel: "discord" }, ctx), undefined);

  // 2. The agent's final reply goes out: chips are attached, text unchanged.
  const res = bridge.replyPayloadSending({ kind: "final", payload: { text: "Place 90° on the unit circle." }, sessionKey: SESSION, channel: "discord" }, ctx);
  assert.equal(res.payload.text, "Place 90° on the unit circle.");
  const buttons = res.payload.channelData.discord.components.blocks[0].buttons;
  assert.deepEqual(buttons.map((b) => b.callbackData), card.suggestedReplies);
  assert.ok(buttons.every((b) => b.allowedUsers[0] === OWNER));
  // Only once per card: a second final payload in the same turn stays plain.
  assert.equal(bridge.replyPayloadSending({ kind: "final", payload: { text: "more" }, sessionKey: SESSION, channel: "discord" }, ctx), undefined);

  // 3. Delivered: the bridge remembers which message carries the chips.
  bridge.messageSent({ to: `channel:${THREAD}`, content: "Place 90° on the unit circle.", success: true, messageId: "1561300000000000003" }, ctx);
  assert.deepEqual(bridge.active.get(THREAD).messageId, "1561300000000000003");

  // 4. Simulated press, as the Discord plugin does it: ack, then dispatch
  //    callbackData into the same session as an inbound message → the agent's
  //    coach tool call for that intent carries exactly that text.
  const pressed = buttons[0];
  const coachCalls = [];
  const simulatedAgentTurn = async (inbound) => {
    await bridge.inbound({ content: inbound.text, sessionKey: inbound.sessionKey, channel: "discord" }, { sessionKey: inbound.sessionKey, channelId: "discord" });
    coachCalls.push({ tool: "intentbios__journey_message", intentId: card.intentId, message: inbound.text });
  };
  await simulatedAgentTurn({ text: pressed.callbackData, sessionKey: SESSION });
  assert.deepEqual(coachCalls, [{ tool: "intentbios__journey_message", intentId: card.intentId, message: "It lands at (0, 1)." }]);

  // 5. The chip message is disabled (pressed chip highlighted), once.
  assert.equal(disabled.length, 1);
  assert.deepEqual(
    { channelId: disabled[0].channelId, messageId: disabled[0].messageId, chosenText: disabled[0].chosenText },
    { channelId: THREAD, messageId: "1561300000000000003", chosenText: "It lands at (0, 1)." },
  );
  await bridge.inbound({ content: "again", sessionKey: SESSION }, ctx);
  assert.equal(disabled.length, 1, "no second edit");
});

test("no chips outside Discord, without suggestions, or on long replies; old chips retire when new ones post", async () => {
  const disabled = [];
  const bridge = createDiscordChipBridge({ token: () => "t", allowedUsers: () => [OWNER], disable: async (a) => { disabled.push(a); return { ok: true }; } });
  bridge.afterToolCall({ toolName: "journey_message", result: mcpResult(card) }, { sessionKey: "agent:main:main" });
  assert.equal(bridge.pending.size, 0);
  bridge.afterToolCall({ toolName: "message", result: mcpResult(card) }, { sessionKey: SESSION });
  assert.equal(bridge.pending.size, 0);
  bridge.afterToolCall({ toolName: "coach_status", result: mcpResult({ ...card, suggestedReplies: [] }) }, { sessionKey: SESSION });
  assert.equal(bridge.pending.size, 0);

  bridge.afterToolCall({ toolName: "coach_status", result: mcpResult(card) }, { sessionKey: SESSION });
  assert.equal(bridge.replyPayloadSending({ kind: "final", payload: { text: "x".repeat(2500) }, sessionKey: SESSION }, {}), undefined);
  assert.equal(bridge.replyPayloadSending({ kind: "final", payload: { text: "ok" }, sessionKey: SESSION }, { channelId: "telegram" }), undefined);

  // Two coach replies in a row: the first chips retire when the second post.
  for (const id of ["1561300000000000010", "1561300000000000011"]) {
    bridge.afterToolCall({ toolName: "coach_status", result: mcpResult(card) }, { sessionKey: SESSION });
    assert.ok(bridge.replyPayloadSending({ kind: "final", payload: { text: "ok" }, sessionKey: SESSION, channel: "discord" }, {}));
    bridge.messageSent({ to: `channel:${THREAD}`, success: true, messageId: id }, { sessionKey: SESSION });
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(disabled.map((d) => d.messageId), ["1561300000000000010"]);
  assert.equal(bridge.active.get(THREAD).messageId, "1561300000000000011");
});

test("two hook registries (tool hook on one, delivery hook on the other) share chip state", () => {
  const store = { pending: new Map(), awaiting: new Map(), active: new Map() };
  const runRegistry = createDiscordChipBridge({ store, allowedUsers: () => [OWNER] });
  const deliveryRegistry = createDiscordChipBridge({ store, allowedUsers: () => [OWNER] });
  runRegistry.afterToolCall({ toolName: "intentbios__journey_message", result: mcpResult(card) }, { sessionKey: SESSION });
  const res = deliveryRegistry.replyPayloadSending({ kind: "final", payload: { text: "Place 90° on the unit circle." }, sessionKey: SESSION, channel: "discord" }, { channelId: "discord", conversationId: `channel:${THREAD}` });
  assert.ok(res?.payload?.channelData?.discord?.components, "chips attached across registries");
});

test("reply hook finds chips by the delivery's conversation when its session key differs", () => {
  const bridge = createDiscordChipBridge({ allowedUsers: () => [OWNER] });
  bridge.afterToolCall({ toolName: "intentbios__journey_message", result: mcpResult(card) }, { sessionKey: SESSION });
  const res = bridge.replyPayloadSending(
    { kind: "final", payload: { text: "Place 90° on the unit circle." }, sessionKey: "agent:main:main", channel: "discord" },
    { channelId: "discord", conversationId: `channel:${THREAD}` },
  );
  assert.ok(res?.payload?.channelData?.discord?.components);
});

test("message tool send (thread intro from the #intents session) gets the chips as components", () => {
  const INTENTS = "1560230058268827713";
  const NEW_THREAD = "1561344578756542584";
  const bridge = createDiscordChipBridge({ allowedUsers: () => [OWNER] });
  const ctx = { sessionKey: `agent:main:discord:channel:${INTENTS}` };
  bridge.afterToolCall({ toolName: "intentbios__intent_create", result: mcpResult(card) }, ctx);
  // Not a send (thread-create): untouched, chips stay queued.
  assert.equal(bridge.beforeToolCall({ toolName: "message", params: { action: "thread-create", channelId: INTENTS, threadName: "x" } }, ctx), undefined);
  const res = bridge.beforeToolCall({ toolName: "message", params: { action: "send", message: "**Learn SAP** — here's the plan.", target: `channel:${NEW_THREAD}` } }, ctx);
  assert.equal(res.params.message, "**Learn SAP** — here's the plan.");
  assert.equal(res.params.target, `channel:${NEW_THREAD}`);
  const buttons = res.params.components.blocks[0].buttons;
  assert.deepEqual(buttons.map((b) => b.callbackData), card.suggestedReplies);
  assert.ok(buttons.every((b) => b.allowedUsers[0] === OWNER));
  // Consumed: the agent's closing reply in #intents stays plain.
  assert.equal(bridge.replyPayloadSending({ kind: "final", payload: { text: "Thread ready." }, sessionKey: ctx.sessionKey, channel: "discord" }, ctx), undefined);
  // The send is tracked against the thread, so the next message there retires the chips.
  bridge.messageSent({ to: `channel:${NEW_THREAD}`, success: true, messageId: "1561344593356914740" }, ctx);
  assert.equal(bridge.active.get(NEW_THREAD).messageId, "1561344593356914740");
});

test("message tool sends that cannot carry chips, or outside Discord sessions, are left alone", () => {
  const bridge = createDiscordChipBridge({ allowedUsers: () => [OWNER] });
  const ctx = { sessionKey: SESSION };
  bridge.afterToolCall({ toolName: "intentbios__journey_message", result: mcpResult(card) }, ctx);
  assert.equal(bridge.beforeToolCall({ toolName: "message", params: { action: "send", message: "x", target: `channel:${THREAD}`, embeds: [{}] } }, ctx), undefined);
  assert.equal(bridge.beforeToolCall({ toolName: "message", params: { action: "send", message: "y".repeat(2000), target: `channel:${THREAD}` } }, ctx), undefined);
  assert.equal(bridge.beforeToolCall({ toolName: "message", params: { action: "send", message: "x" } }, { sessionKey: "agent:main:main" }), undefined);
  assert.equal(bridge.beforeToolCall({ toolName: "exec", params: { action: "send", message: "x" } }, ctx), undefined);
  // Still queued for the real reply.
  assert.ok(bridge.replyPayloadSending({ kind: "final", payload: { text: "ok" }, sessionKey: SESSION, channel: "discord" }, ctx));
});
