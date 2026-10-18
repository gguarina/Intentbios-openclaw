/**
 * Chips through the real @openclaw/discord code (opt-in: the plugin is not a repo
 * dependency). Point OPENCLAW_DISCORD_DIST at an unpacked @openclaw/discord dist
 * whose node_modules can resolve `openclaw`, e.g.
 *   npm pack @openclaw/discord@2026.9.4 && tar xf openclaw-discord-*.tgz
 *   ln -s "$(npm root -g)/openclaw" package/node_modules/openclaw
 *   OPENCLAW_DISCORD_DIST=$PWD/package/dist node --test plugins/intentbios/discord-chips.native.test.mjs
 *
 * Covers: our reply payload → the plugin's component spec → the Discord message it
 * builds → its component registry → a press (custom_id) resolving to the button →
 * the text the plugin dispatches into the session (the full suggested reply).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createDiscordChipBridge } from "./index.js";

const DIST = process.env.OPENCLAW_DISCORD_DIST || "";
const find = (prefix) => fs.readdirSync(DIST).find((f) => f.startsWith(prefix) && f.endsWith(".js"));

const OWNER = "1560179504196886610";
const SESSION = "agent:main:discord:channel:1561297516228648994";
const replies = [
  "It lands at (0, 1).",
  "Could you explain once more why the sine of an angle is the y coordinate on the unit circle please",
  "I'm stuck",
];

test("native Discord components: payload → message → registry → press → dispatched text", { skip: !DIST && "OPENCLAW_DISCORD_DIST not set" }, async () => {
  const outbound = await import(path.join(DIST, find("outbound-components-")));
  const components = await import(path.join(DIST, find("components-")));
  const sendComponents = await import(path.join(DIST, find("send.components-")));
  const resolveDiscordComponentSpec = outbound.i;
  const buildDiscordComponentMessage = components.d;
  const parseDiscordComponentCustomId = components.w;
  const registerBuiltDiscordComponentMessage = sendComponents.n;
  const resolveEntry = sendComponents.a;

  const bridge = createDiscordChipBridge({ token: () => "", allowedUsers: () => [OWNER] });
  bridge.afterToolCall({
    toolName: "intentbios__coach_status",
    result: { content: [{ type: "text", text: JSON.stringify({ reply: "r", deepLink: "https://x/y", intentId: "intent_mvdkol18_xtnuyd", suggestedReplies: replies }) }] },
  }, { sessionKey: SESSION });
  const { payload } = bridge.replyPayloadSending({ kind: "final", channel: "discord", sessionKey: SESSION, payload: { text: "Place 450° on the unit circle." } }, {});

  // What the Discord outbound adapter does with the payload (sendDiscordOutboundPayload).
  const spec = await resolveDiscordComponentSpec(payload);
  assert.equal(spec.text, "Place 450° on the unit circle.");
  const built = buildDiscordComponentMessage({ spec, accountId: "default" });
  const json = JSON.parse(JSON.stringify(built.components.map((c) => (typeof c.serialize === "function" ? c.serialize() : c))));
  const container = json[0];
  assert.equal(container.type, 17, "components v2 container");
  assert.equal(container.components[0].type, 10, "reply text block");
  const row = container.components[1];
  assert.equal(row.type, 1);
  assert.equal(row.components.length, 3);
  for (const button of row.components) {
    assert.equal(button.type, 2);
    assert.ok(button.label.length <= 80);
    assert.match(button.custom_id, /^occomp:/);
  }
  assert.ok(row.components[1].label.endsWith("…"));

  registerBuiltDiscordComponentMessage({ buildResult: built, messageId: "1561300000000000099" });
  // A press arrives with the button's custom_id; the plugin resolves and consumes the entry.
  const pressed = parseDiscordComponentCustomId(row.components[1].custom_id);
  const peek = await resolveEntry({ id: pressed.componentId, consume: false });
  assert.deepEqual(peek.allowedUsers, [OWNER], "others are refused with an ephemeral notice");
  const consumed = await resolveEntry({ id: pressed.componentId, consume: true });
  assert.equal(consumed.kind, "button");
  assert.equal(consumed.callbackDataKind, undefined);
  // handleDiscordComponentEvent: a button with callbackData and no "callback" kind
  // dispatches that callbackData as the inbound message text.
  const eventText = consumed.kind === "button" && consumed.callbackDataKind !== "callback" ? consumed.callbackData?.trim() : null;
  assert.equal(eventText, replies[1], "the full suggested reply, not the truncated label");
  // Single use for the whole row: the sibling chips expired with the press.
  for (const sibling of [row.components[0], row.components[2]]) {
    assert.equal(await resolveEntry({ id: parseDiscordComponentCustomId(sibling.custom_id).componentId, consume: false }), null);
  }
});
