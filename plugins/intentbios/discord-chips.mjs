/**
 * Suggested-reply chips on Discord coach replies (deterministic; no model involved).
 *
 * The coach card's `suggestedReplies` become Discord buttons attached to the agent's
 * reply in an intent thread. They ride OpenClaw's native Discord components path
 * (`channelData.discord.components` on the outgoing reply payload), so the Discord
 * plugin registers each button, checks `allowedUsers` (others get an ephemeral
 * "not authorized"), acknowledges the click at once (ephemeral "✓"), and routes the
 * button's `callbackData` — the full suggested reply — into the same session as an
 * inbound message, exactly like a typed one. Buttons on one message share a
 * single-use consumption group: pressing one expires all of them.
 *
 * This module also disables the buttons on the message afterwards (so stale chips
 * look spent), by editing the message over REST with the bot token.
 */
import { discordRequest } from "./discord-bridge.mjs";

export const MAX_CHIPS = 5;
export const MAX_LABEL = 80;
export const MAX_CALLBACK = 1_000;
export const PER_ROW = 5;
/** Replies longer than this keep their plain shape (a components message holds one text block). */
export const MAX_REPLY_TEXT = 1_900;
export const DEFAULT_ALLOWED_USERS = ["1560179504196886610"];

const BUTTON = 2;
const ACTION_ROW = 1;
const LINK_STYLE = 5;
const SUCCESS_STYLE = 3;

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** Button label: ≤ max chars, cut at a word boundary with an ellipsis. */
export function chipLabel(text, max = MAX_LABEL) {
  const value = clean(text);
  if (value.length <= max) return value;
  const room = max - 1; // the ellipsis
  let cut = value.lastIndexOf(" ", room);
  if (cut < Math.floor(room / 2)) cut = room; // one very long word: hard cut
  const head = value.slice(0, cut).replace(/[\s,;:.!?·—–-]+$/u, "");
  return `${head || value.slice(0, room)}…`;
}

/** Distinct, non-empty suggested replies (at most MAX_CHIPS). */
export function suggestedRepliesFromCard(card) {
  const raw = Array.isArray(card?.suggestedReplies)
    ? card.suggestedReplies
    : Array.isArray(card?.coachCard?.suggestedReplies)
      ? card.coachCard.suggestedReplies
      : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = clean(item);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
}

/** Allowed button users: DISCORD_ALLOWED_USER_IDS, else the owner's id. */
export function allowedChipUsers(raw = process.env.DISCORD_ALLOWED_USER_IDS) {
  const ids = String(raw || "").split(/[\s,]+/).filter((id) => /^\d{15,25}$/.test(id));
  return ids.length ? ids : [...DEFAULT_ALLOWED_USERS];
}

/**
 * The OpenClaw Discord components spec for a chip row (rows of 5). The payload text
 * becomes the message's text block. `callbackData` (no `callbackDataKind`) is what
 * the Discord plugin sends into the session when the button is pressed.
 */
export function chipComponentsSpec(replies, { allowedUsers = allowedChipUsers() } = {}) {
  const buttons = replies.slice(0, MAX_CHIPS).map((text) => ({
    label: chipLabel(text),
    style: "secondary",
    callbackData: text.slice(0, MAX_CALLBACK),
    allowedUsers,
  }));
  const blocks = [];
  for (let i = 0; i < buttons.length; i += PER_ROW) blocks.push({ type: "actions", buttons: buttons.slice(i, i + PER_ROW) });
  return { reusable: false, blocks };
}

const hasMedia = (payload) => Boolean(payload?.mediaUrl) || (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.some(Boolean))
  || (Array.isArray(payload?.attachments) && payload.attachments.length > 0);

/** Why a reply payload cannot carry chips (null = it can). */
export function chipSkipReason(payload) {
  if (!payload || typeof payload !== "object") return "no payload";
  if (payload.isError || payload.isReasoning || payload.isCommentary) return "not a reply";
  const text = String(payload.text || "").trim();
  if (!text) return "no text";
  if (text.length > MAX_REPLY_TEXT) return "reply too long";
  if (hasMedia(payload)) return "has media";
  if (payload.presentation || payload.interactive || payload.audioAsVoice) return "already rich";
  const discord = payload.channelData?.discord;
  if (discord && (discord.components || discord.presentationComponents || discord.embeds)) return "already rich";
  return null;
}

/** The reply payload with the chips attached (native Discord components). */
export function withChips(payload, replies, opts) {
  const channelData = payload.channelData && typeof payload.channelData === "object" ? payload.channelData : {};
  const discord = channelData.discord && typeof channelData.discord === "object" ? channelData.discord : {};
  return {
    ...payload,
    channelData: { ...channelData, discord: { ...discord, components: chipComponentsSpec(replies, opts) } },
  };
}

function walk(components, fn) {
  return (Array.isArray(components) ? components : []).map((component) => {
    const next = fn(component) || component;
    return Array.isArray(next.components) ? { ...next, components: walk(next.components, fn) } : next;
  });
}

/** Buttons labelled like the chips (to recognise a chip message). */
export function buttonLabels(components) {
  const labels = [];
  walk(components, (c) => { if (c?.type === BUTTON && c.style !== LINK_STYLE) labels.push(String(c.label || "")); });
  return labels;
}

/** Every chip button disabled; the chosen one (if known) green. Null when nothing to change. */
export function disabledChipComponents(components, chosenText = "") {
  const chosen = clean(chosenText).toLowerCase();
  let changed = false;
  const next = walk(components, (c) => {
    if (c?.type !== BUTTON || c.style === LINK_STYLE || c.disabled) return null;
    changed = true;
    const label = clean(c.label).replace(/…$/u, "").toLowerCase();
    const picked = chosen && label && (chosen === label || chosen.startsWith(label) || chosen.includes(label));
    return { ...c, disabled: true, ...(picked ? { style: SUCCESS_STYLE } : {}) };
  });
  return changed ? next : null;
}

const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Disable the chips on one message (GET it, flip its buttons, PATCH components).
 * Without a message id, finds the newest bot message in the channel whose buttons
 * carry the chip labels.
 */
export async function disableChipsOnMessage({ token, channelId, messageId, labels = [], chosenText = "", request = discordRequest, botUserId }) {
  if (!token || !SNOWFLAKE.test(String(channelId || ""))) return { ok: false, reason: "no channel" };
  let message = null;
  if (SNOWFLAKE.test(String(messageId || ""))) {
    message = await request(token, "GET", `/channels/${channelId}/messages/${messageId}`);
  } else if (labels.length) {
    const recent = await request(token, "GET", `/channels/${channelId}/messages?limit=10`);
    const want = new Set(labels);
    message = (Array.isArray(recent) ? recent : []).find((m) => (!botUserId || m?.author?.id === botUserId)
      && m?.author?.bot && buttonLabels(m.components).some((label) => want.has(label))) || null;
  }
  if (!message?.id) return { ok: false, reason: "message not found" };
  const components = disabledChipComponents(message.components, chosenText);
  if (!components) return { ok: true, messageId: message.id, changed: false };
  await request(token, "PATCH", `/channels/${channelId}/messages/${message.id}`, { components, allowed_mentions: { parse: [] } });
  return { ok: true, messageId: message.id, changed: true };
}
