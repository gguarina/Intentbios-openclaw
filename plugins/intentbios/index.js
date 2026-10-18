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
  store = { pending: new Map(), recent: new Map() },
} = {}) {
  const { pending, recent } = store; // pending: sessionKey -> { channelId, embeds, settle, fallback }; recent: channelId|url -> postedAt

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
/**
 * Process-wide state for the Discord bridges. OpenClaw can register this plugin in
 * more than one hook registry (the agent run's runner fires `after_tool_call`, the
 * channel delivery fires `reply_payload_sending` / `message_sent`), so per-instance
 * maps never see each other's events. Everything that must cross hooks lives here.
 */
const SHARED_KEY = Symbol.for("intentbios.discordBridges.v2");
export function sharedBridgeStore() {
  const g = globalThis;
  if (!g[SHARED_KEY]) {
    g[SHARED_KEY] = {
      embeds: { pending: new Map(), recent: new Map() },
      chips: { pending: new Map(), awaiting: new Map(), active: new Map() },
    };
  }
  return g[SHARED_KEY];
}

const SNOWFLAKE = /^\d{15,25}$/;
/** A Discord channel/thread id out of a target like "channel:123", "discord:channel:123", "123". */
export function discordTargetChannel(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (SNOWFLAKE.test(text)) return text;
  const m = text.match(/(?:^|[:/])(\d{15,25})$/);
  return m ? m[1] : null;
}

/**
 * Suggested-reply chips (see discord-chips.mjs). State is keyed by Discord channel
 * (thread) id, not by session key, and lives in the shared store, so it survives
 * the hook-registry split and session-key variants (parent channel vs thread).
 *
 * Two attach points, both native OpenClaw components:
 *  - `reply_payload_sending` (the agent's normal reply): sets channelData.discord.components;
 *  - `before_tool_call` on the `message` tool's `send` (thread intros and any reply the
 *    agent posts with the tool): adds the `components` param the Discord send action reads.
 */
export function createDiscordChipBridge({
  token = () => process.env.DISCORD_BOT_TOKEN,
  allowedUsers = () => allowedChipUsers(),
  disable = disableChipsOnMessage,
  pendingTtlMs = 15 * 60_000,
  store = { pending: new Map(), awaiting: new Map(), active: new Map() },
  log = () => {},
} = {}) {
  const { pending, awaiting, active } = store; // pending/awaiting/active: channelId -> entry

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

  /** The freshest pending chips for any of these channels (thread first). */
  const takePending = (channelIds) => {
    for (const id of channelIds) {
      if (!id) continue;
      const entry = pending.get(id);
      if (!entry) continue;
      if (!fresh(entry)) { pending.delete(id); continue; }
      return { id, entry };
    }
    return null;
  };

  const markAwaiting = (channelId, replies, text) => {
    awaiting.set(channelId, { channelId, labels: replies.map((t) => chipLabel(t)), text, at: Date.now() });
  };

  const afterToolCall = (event, ctx) => {
    if (!isIntentbiosTool(event?.toolName || ctx?.toolName)) return;
    const sessionKey = String(ctx?.sessionKey || "");
    const channelId = discordChannelFromSessionKey(sessionKey);
    if (!channelId) return;
    const card = extractCard(event?.result);
    if (!card) return;
    const replies = suggestedRepliesFromCard(card);
    if (replies.length) {
      pending.set(channelId, { channelId, sessionKey, replies, at: Date.now() });
      log("info", `queued ${replies.length} chip(s) for ${channelId}`);
    } else {
      pending.delete(channelId); // the latest card wins, even when it has none
    }
  };

  const replyPayloadSending = (event, ctx) => {
    const sessionKey = String(event?.sessionKey || ctx?.sessionKey || "");
    const channel = String(event?.channel || ctx?.channelId || "").toLowerCase();
    if (channel && channel !== "discord") return undefined;
    const fromKey = discordChannelFromSessionKey(sessionKey);
    const fromConv = discordTargetChannel(ctx?.conversationId);
    if (!fromKey && !fromConv) return undefined;
    const hit = takePending([fromKey, fromConv]);
    if (!hit) return undefined;
    if (event?.kind && event.kind !== "final") {
      log("info", `chips held for ${hit.id}: ${event.kind} payload`);
      return undefined;
    }
    const skip = chipSkipReason(event?.payload);
    if (skip) {
      log("info", `chips not attached in ${hit.id}: ${skip}`);
      return undefined;
    }
    pending.delete(hit.id);
    const payload = withChips(event.payload, hit.entry.replies, { allowedUsers: allowedUsers() });
    markAwaiting(fromConv || hit.id, hit.entry.replies, String(event.payload.text || "").trim());
    log("info", `attached ${hit.entry.replies.length} chip(s) to the coach reply in ${fromConv || hit.id}`);
    return { payload };
  };

  /** The agent posting with the message tool (thread intro, or a reply sent as a tool call). */
  const beforeToolCall = (event, ctx) => {
    const tool = String(event?.toolName || ctx?.toolName || "");
    if (tool !== "message") return undefined;
    const params = event?.params && typeof event.params === "object" ? event.params : null;
    if (!params || String(params.action || "") !== "send") return undefined;
    if (params.channel && String(params.channel).toLowerCase() !== "discord") return undefined;
    const sessionKey = String(ctx?.sessionKey || "");
    const sessionChannel = discordChannelFromSessionKey(sessionKey);
    if (!sessionChannel) return undefined; // only Discord sessions
    const target = discordTargetChannel(params.target ?? params.to ?? params.threadId ?? params.channelId) || sessionChannel;
    const hit = takePending([target, sessionChannel]);
    if (!hit) return undefined;
    if (params.components || (Array.isArray(params.embeds) && params.embeds.length) || params.mediaUrl || params.path || params.filePath || params.media) {
      log("info", `chips not attached to message send in ${target}: already rich`);
      return undefined;
    }
    const text = String(params.message ?? params.content ?? params.text ?? "").trim();
    const skip = chipSkipReason({ text });
    if (skip) {
      log("info", `chips not attached to message send in ${target}: ${skip}`);
      return undefined;
    }
    pending.delete(hit.id);
    const spec = withChips({ text }, hit.entry.replies, { allowedUsers: allowedUsers() }).channelData.discord.components;
    markAwaiting(target, hit.entry.replies, text);
    log("info", `attached ${hit.entry.replies.length} chip(s) to the message send in ${target}`);
    return { params: { ...params, components: spec } };
  };

  const messageSent = (event, ctx) => {
    const candidates = [
      discordTargetChannel(event?.to),
      discordTargetChannel(ctx?.conversationId),
      discordChannelFromSessionKey(String(ctx?.sessionKey || event?.sessionKey || "")),
    ].filter(Boolean);
    const channelId = candidates.find((id) => awaiting.has(id));
    if (!channelId) return;
    const entry = awaiting.get(channelId);
    awaiting.delete(channelId);
    if (event?.success === false) return;
    const previous = active.get(channelId);
    const messageId = SNOWFLAKE.test(String(event?.messageId || "")) ? String(event.messageId) : null;
    if (previous && previous.messageId !== messageId) void retire(channelId);
    active.set(channelId, { messageId, labels: entry.labels });
  };

  /** Inbound message (typed, or a chip press routed as one): chips above it are spent. */
  const inbound = (event, ctx) => {
    const sessionKey = String(event?.sessionKey || ctx?.sessionKey || "");
    const fromKey = discordChannelFromSessionKey(sessionKey);
    const conv = String(ctx?.conversationId || "").match(/(?:^|:)(\d{15,25})$/)?.[1] || null;
    const channelId = fromKey || ((String(ctx?.channelId || event?.channel || "").toLowerCase() === "discord") ? conv : null);
    if (!channelId) return null;
    pending.delete(channelId);
    if (!active.has(channelId)) return null;
    return retire(channelId, String(event?.content || event?.body || ""));
  };

  return { afterToolCall, replyPayloadSending, beforeToolCall, messageSent, inbound, pending, awaiting, active };
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
      const shared = sharedBridgeStore();
      const bridge = createDiscordEmbedBridge({
        store: shared.embeds,
        log: (level, message) => (level === "warn" ? console.warn : console.log)(`[intentbios] ${message}`),
      });
      api.on("after_tool_call", (event, ctx) => bridge.afterToolCall(event, ctx));
      api.on("message_sent", (event, ctx) => bridge.messageSent(event, ctx));

      const chips = createDiscordChipBridge({
        store: shared.chips,
        log: (level, message) => (level === "warn" ? console.warn : console.log)(`[intentbios] ${message}`),
      });
      api.on("after_tool_call", (event, ctx) => chips.afterToolCall(event, ctx));
      api.on("reply_payload_sending", (event, ctx) => chips.replyPayloadSending(event, ctx));
      api.on("before_tool_call", (event, ctx) => chips.beforeToolCall(event, ctx));
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
