/**
 * OpenClaw plugin: intentbios-coach tools.
 * These tools only call Intentbios HTTP. They do not generate lessons.
 */
import { executeIntentbiosTool, COACH_TOOL_NAMES } from "./client.mjs";

const TOOLS = {
  intent_create: {
    description:
      "Create an Intentbios intent. Sends rawInput to POST /api/intents. Does not generate lessons.",
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
      "Ask on an existing intent. POST /api/intents/:id/journey/message. Journey completion rules stay inside Intentbios.",
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
  },
};
