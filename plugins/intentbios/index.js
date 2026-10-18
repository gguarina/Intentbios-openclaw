/**
 * OpenClaw plugin: intentbios-coach tools.
 * These tools only call Intentbios HTTP. They do not generate lessons.
 */
import { executeIntentbiosTool, COACH_TOOL_NAMES } from "./client.mjs";
import { createDiscordLinkHandler, discordUserIdFromSender, redeemDiscordLink } from "./linkCommand.mjs";
import {
  dedupeEmbeds,
  discordChannelFromSessionKey,
  embedsForCard,
  extractCard,
  isIntentbiosTool,
  postMessage,
  recordThread,
} from "./discord-bridge.mjs";
import {
  allowedChipUsers,
  chipLabel,
  chipSkipReason,
  disableChipsOnMessage,
  suggestedRepliesFromCard,
  withChips,
} from "./discord-chips.mjs";

const TOOLS = {
  intent_create: {
    description:
      "Create an Intentbios intent. Sends rawInput to POST /api/intents. Does not generate lessons. Forwards coachCard (summary, deepLink, suggestedReplies) when Intentbios sends one.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        rawInput: { type: "string", description: "What the person wants to do." },
        userId: { type: "string", description: "Intentbios user id, sent as x-user-id." },
        hoursPerWeek: { type: "number" },
        sessionKey: { type: "string" },
      },
      required: ["rawInput", "userId"],
    },
  },
  journey_message: {
    description:
      "Ask on an existing intent. POST /api/intents/:id/journey/message. Journey completion rules stay inside Intentbios. Forwards coachCard (summary, deepLink, suggestedReplies) beside the short reply when Intentbios sends one.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        intentId: { type: "string" },
        message: { type: "string", description: "The Ask message." },
        userId: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["intentId", "message", "userId"],
    },
  },
  intent_execute: {
    description:
      "Run one intent action: scene, quiz, lock (lockDecision), or clarify (clarifyIntent). POST /api/intents/:id/execute.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        intentId: { type: "string" },
        actionTarget: {
          type: "string",
          description: "clarifyIntent, lockDecision, or the scene/quiz action target.",
        },
        payload: { type: "object", additionalProperties: true },
        idempotencyKey: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["intentId", "actionTarget", "userId"],
    },
  },
  state_snapshot: {
    description: "Read journey graph state. GET /api/intents/:id/journey-graphs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        intentId: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["intentId", "userId"],
    },
  },
  lesson_status: {
    description:
      "Read lesson status from the intent goal. Does not generate or rewrite lessons.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        intentId: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["intentId", "userId"],
    },
  },
};

function pluginSettings(api) {
  const fromApi = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  return {
    baseUrl: String(fromApi.apiUrl || process.env.INTENTBIOS_API_URL || "").trim(),
    defaultUserId: String(
      fromApi.defaultUserId || process.env.INTENTBIOS_DEFAULT_USER_ID || "",
    ).trim(),
  };
}

/**
 * Per-requester transport for the statically declared `intentbios` MCP server.
 *
 * A Discord message is sent as the sender's `discord:<snowflake>` identity, so
 * the Intentbios server's `resolveCoachIdentity` writes as the account that
 * Discord user paired with. Every other caller (webchat, dashboard) keeps the
 * configured static `x-user-id`, exactly as before.
 *
 * `ctx.requesterSenderId` is host-trusted; the id is never read from the
 * message body. Returns null when no base URL is configured, which omits the
 * server for that run instead of connecting somewhere unproven.
 */
export function resolveIntentbiosMcpConnection(ctx, settings = {}) {
  const configured = String(process.env.INTENTBIOS_MCP_URL || settings.baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!configured) return null;
  const url = process.env.INTENTBIOS_MCP_URL ? configured : `${configured}/mcp`;
  const channel = String(ctx?.messageChannel || "").trim().toLowerCase();
  const discordUserId = channel === "discord" ? discordUserIdFromSender(ctx?.requesterSenderId) : null;
  const staticUserId =
    String(settings.defaultUserId || process.env.INTENTBIOS_MCP_USER_ID || "gustavo").trim() || "gustavo";
  const headers = { "x-user-id": discordUserId ? `discord:${discordUserId}` : staticUserId };
  const apiKey = String(process.env.INTENTBIOS_MCP_API_KEY || "").trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url, headers };
}

/**
 * Figures and equations as Discord embeds, posted by code — not by the model.
 *
 * `after_tool_call` on an Intentbios tool in a Discord session: remember the
 * intent → thread mapping (so Ask turns can mirror there) and stash the card's
 * figure/equation embeds. `message_sent` for that session (the agent's reply is
 * out): post the embeds right after it. A fallback timer posts them if no reply
 * is seen. Bot token from env; never logged.
 */
export function createDiscordEmbedBridge({
  stateDir = process.env.OPENCLAW_STATE_DIR || "",
  token = () => process.env.DISCORD_BOT_TOKEN,
  post = postMessage,
  settleMs = 2_500,
  fallbackMs = 45_000,
  log = () => {},
} = {}) {
  const pending = new Map(); // sessionKey -> { channelId, embeds, settle, fallback }
  const recent = new Map(); // channelId|url -> postedAt (no repeat within 2 minutes)

  const flush = async (sessionKey) => {
    const entry = pending.get(sessionKey);
    if (!entry) return;
    pending.delete(sessionKey);
    clearTimeout(entry.settle);
    clearTimeout(entry.fallback);
    const now = Date.now();
    const embeds = entry.embeds.filter((embed) => (recent.get(`${entry.channelId}|${embed.image.url}`) || 0) < now - 120_000);
    if (!embeds.length) return;
    try {
      await post(token(), entry.channelId, { embeds });
      for (const embed of embeds) recent.set(`${entry.channelId}|${embed.image.url}`, now);
      if (recent.size > 500) recent.delete(recent.keys().next().value);
      log("info", `posted ${embeds.length} embed(s) to discord channel ${entry.channelId}`);
    } catch (err) {
      log("warn", `embed post failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const afterToolCall = (event, ctx) => {
    if (!isIntentbiosTool(event?.toolName || ctx?.toolName)) return;
    const sessionKey = String(ctx?.sessionKey || "");
    const channelId = discordChannelFromSessionKey(sessionKey);
    if (!channelId) return;
    const card = extractCard(event?.result);
    if (!card) return;
    const intentId = String(card.intentId || event?.params?.intentId || "").trim();
    if (intentId && stateDir) {
      try { recordThread(stateDir, intentId, channelId); } catch (err) { log("warn", `thread mapping failed: ${err.message}`); }
    }
    const embeds = embedsForCard(card);
    if (!embeds.length || !token()) return;
    const entry = pending.get(sessionKey) || { channelId, embeds: [] };
    entry.embeds = dedupeEmbeds([...entry.embeds, ...embeds]).slice(0, 10);
    clearTimeout(entry.fallback);
    entry.fallback = setTimeout(() => void flush(sessionKey), fallbackMs);
    entry.fallback.unref?.();
    pending.set(sessionKey, entry);
  };

  const messageSent = (event, ctx) => {
    let sessionKey = String(ctx?.sessionKey || event?.sessionKey || "");
    if (!pending.has(sessionKey)) {
      // No session on the delivery: match the target channel instead (`to` names it).
      const to = String(event?.to || ctx?.conversationId || "");
      sessionKey = [...pending.keys()].find((key) => to && to.includes(pending.get(key).channelId)) || "";
    }
    const entry = pending.get(sessionKey);
    if (!entry || event?.success === false) return;
    // Settle: a reply can be delivered in several chunks; embeds go after the last.
    clearTimeout(entry.settle);
    entry.settle = setTimeout(() => void flush(sessionKey), settleMs);
    entry.settle.unref?.();
  };

  return { afterToolCall, messageSent, flush, pending };
}

/**
 * Suggested-reply chips under coach replies in Discord, attached by code — not by
 * the model (no tokens).
 *
 * `after_tool_call` on an Intentbios tool in a Discord session: remember the card's
 * suggestedReplies. `reply_payload_sending` (the agent's final reply for that
 * session): attach them as native Discord buttons (see discord-chips.mjs).
 * `message_sent`: remember which message carries them. The next inbound message in
 * that channel — a chip press arrives as one, a typed reply too — disables them.
 */
export function createDiscordChipBridge({
  token = () => process.env.DISCORD_BOT_TOKEN,
  allowedUsers = () => allowedChipUsers(),
  disable = disableChipsOnMessage,
  pendingTtlMs = 15 * 60_000,
  log = () => {},
} = {}) {
  const pending = new Map(); // sessionKey -> { channelId, replies, at }
  const awaiting = new Map(); // sessionKey -> { channelId, replies, labels, text, at }
  const active = new Map(); // channelId -> { messageId, labels }

  const fresh = (entry) => entry && Date.now() - entry.at < pendingTtlMs;

  const retire = (channelId, chosenText = "") => {
    const entry = active.get(channelId);
    if (!entry) return null;
    active.delete(channelId);
    const tok = token();
    if (!tok) return null;
    return Promise.resolve()
      .then(() => disable({ token: tok, channelId, messageId: entry.messageId, labels: entry.labels, chosenText }))
      .then((res) => {
        if (res?.changed) log("info", `disabled chips on message ${res.messageId} in ${channelId}`);
        return res;
      })
      .catch((err) => {
        log("warn", `chip disable failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
  };

  const afterToolCall = (event, ctx) => {
    if (!isIntentbiosTool(event?.toolName || ctx?.toolName)) return;
    const sessionKey = String(ctx?.sessionKey || "");
    const channelId = discordChannelFromSessionKey(sessionKey);
    if (!channelId) return;
    const card = extractCard(event?.result);
    if (!card) return;
    const replies = suggestedRepliesFromCard(card);
    if (replies.length) pending.set(sessionKey, { channelId, replies, at: Date.now() });
    else pending.delete(sessionKey); // the latest card wins, even when it has none
  };

  const replyPayloadSending = (event, ctx) => {
    if (event?.kind && event.kind !== "final") return undefined;
    const sessionKey = String(event?.sessionKey || ctx?.sessionKey || "");
    const entry = pending.get(sessionKey);
    if (!entry) return undefined;
    if (!fresh(entry)) { pending.delete(sessionKey); return undefined; }
    const channel = String(event?.channel || ctx?.channelId || "").toLowerCase();
    if (channel && channel !== "discord") return undefined;
    const skip = chipSkipReason(event?.payload);
    if (skip) {
      log("info", `chips not attached in ${entry.channelId}: ${skip}`);
      return undefined;
    }
    pending.delete(sessionKey);
    const payload = withChips(event.payload, entry.replies, { allowedUsers: allowedUsers() });
    awaiting.set(sessionKey, {
      channelId: entry.channelId,
      labels: entry.replies.map((text) => chipLabel(text)),
      text: String(event.payload.text || "").trim(),
      at: Date.now(),
    });
    log("info", `attached ${entry.replies.length} chip(s) to the coach reply in ${entry.channelId}`);
    return { payload };
  };

  const messageSent = (event, ctx) => {
    let sessionKey = String(ctx?.sessionKey || event?.sessionKey || "");
    if (!awaiting.has(sessionKey)) {
      const to = String(event?.to || ctx?.conversationId || "");
      sessionKey = [...awaiting.keys()].find((key) => to && to.includes(awaiting.get(key).channelId)) || "";
    }
    const entry = awaiting.get(sessionKey);
    if (!entry) return;
    if (event?.success === false) { awaiting.delete(sessionKey); return; }
    awaiting.delete(sessionKey);
    const previous = active.get(entry.channelId);
    const messageId = /^\d{15,25}$/.test(String(event?.messageId || "")) ? String(event.messageId) : null;
    if (previous && previous.messageId !== messageId) void retire(entry.channelId);
    active.set(entry.channelId, { messageId, labels: entry.labels });
  };

  /** Inbound message (typed, or a chip press routed as one): chips above it are spent. */
  const inbound = (event, ctx) => {
    const sessionKey = String(event?.sessionKey || ctx?.sessionKey || "");
    const fromKey = discordChannelFromSessionKey(sessionKey);
    const conv = String(ctx?.conversationId || "").match(/(?:^|:)(\d{15,25})$/)?.[1] || null;
    const channelId = fromKey || ((String(ctx?.channelId || event?.channel || "").toLowerCase() === "discord") ? conv : null);
    if (sessionKey) pending.delete(sessionKey);
    if (!channelId || !active.has(channelId)) return null;
    return retire(channelId, String(event?.content || event?.body || ""));
  };

  return { afterToolCall, replyPayloadSending, messageSent, inbound, pending, awaiting, active };
}

function sessionKeyFromContext(ctx, params) {
  return (
    params?.sessionKey ||
    ctx?.sessionKey ||
    ctx?.session?.key ||
    ctx?.sessionId ||
    ""
  );
}

export default {
  id: "intentbios",
  name: "Intentbios coach tools",
  description:
    "HTTP tools for intentbios-coach. Lesson generation stays inside Intentbios.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      apiUrl: { type: "string" },
      defaultUserId: { type: "string" },
    },
  },
  register(api) {
    const settings = pluginSettings(api);

    // The bot's half of the Discord ↔ Intentbios pairing. A deterministic
    // `before_dispatch` hook claims a link attempt (a `/link <code>` message, or
    // a bare pasted code) and redeems it with the Discord user id off the event
    // — never a prompt instruction, never the id read from the message text.
    // Every other message falls through to the normal agent path untouched.
    if (typeof api.on === "function") {
      api.on(
        "before_dispatch",
        createDiscordLinkHandler({
          redeem: ({ code, discordUserId }) =>
            redeemDiscordLink({
              code,
              discordUserId,
              baseUrl: settings.baseUrl,
              apiKey: process.env.INTENTBIOS_MCP_API_KEY,
            }),
          log: (level, message) => {
            const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
            fn(`[intentbios] ${message}`);
          },
        }),
      );
    }

    if (typeof api.on === "function") {
      const bridge = createDiscordEmbedBridge({
        log: (level, message) => (level === "warn" ? console.warn : console.log)(`[intentbios] ${message}`),
      });
      api.on("after_tool_call", (event, ctx) => bridge.afterToolCall(event, ctx));
      api.on("message_sent", (event, ctx) => bridge.messageSent(event, ctx));

      const chips = createDiscordChipBridge({
        log: (level, message) => (level === "warn" ? console.warn : console.log)(`[intentbios] ${message}`),
      });
      api.on("after_tool_call", (event, ctx) => chips.afterToolCall(event, ctx));
      api.on("reply_payload_sending", (event, ctx) => chips.replyPayloadSending(event, ctx));
      api.on("message_sent", (event, ctx) => chips.messageSent(event, ctx));
      // Fire-and-forget: never hold up dispatch (and never claim the message).
      api.on("before_dispatch", (event, ctx) => { void chips.inbound(event, ctx); });
      api.on("message_received", (event, ctx) => { void chips.inbound(event, ctx); });
    }

    for (const name of COACH_TOOL_NAMES) {
      const spec = TOOLS[name];
      api.registerTool(
        (ctx) => ({
          name,
          description: spec.description,
          parameters: spec.parameters,
          async execute(_toolCallId, params) {
            try {
              const details = await executeIntentbiosTool(name, params || {}, {
                baseUrl: settings.baseUrl,
                defaultUserId: settings.defaultUserId,
                sessionKey: sessionKeyFromContext(ctx, params),
              });
              return {
                content: [{ type: "text", text: JSON.stringify(details) }],
                details,
              };
            } catch (err) {
              const details = {
                error: err instanceof Error ? err.message : String(err),
                status: err?.status || null,
              };
              return {
                content: [{ type: "text", text: JSON.stringify(details) }],
                details,
                isError: true,
              };
            }
          },
        }),
        { name },
      );
    }

    // The `intentbios` MCP server is declared statically (name, tool filter);
    // this binds its transport to the trusted requester so a Discord message
    // acts as that sender, not the static user. Older hosts no-op the call.
    if (typeof api.registerMcpServerConnectionResolver === "function") {
      api.registerMcpServerConnectionResolver({
        serverName: "intentbios",
        resolve: (ctx) => resolveIntentbiosMcpConnection(ctx, settings),
      });
    }
  },
};
