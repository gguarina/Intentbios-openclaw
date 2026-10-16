/**
 * OpenClaw plugin: intentbios-coach tools.
 * These tools only call Intentbios HTTP. They do not generate lessons.
 */
import { executeIntentbiosTool, COACH_TOOL_NAMES } from "./client.mjs";
import { createDiscordLinkHandler, discordUserIdFromSender, redeemDiscordLink } from "./linkCommand.mjs";

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
