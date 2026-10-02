import {
  COACH_AGENT_ID,
  createIntentbiosClient,
} from "./client.mjs";

const objectSchema = (properties, required) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const userIdField = {
  type: "string",
  description: "Intentbios user id. Falls back to the plugin defaultUserId.",
};

const intentIdField = {
  type: "string",
  description: "Intentbios intent id returned by intent_create.",
};

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function toolError(error) {
  const details = {
    error: error?.message || String(error),
  };
  if (error?.status) details.status = error.status;
  if (error?.payload !== undefined) details.payload = error.payload;
  return toolResult(details);
}

function clientFrom(api, ctx) {
  const pluginConfig = api.pluginConfig || {};
  return createIntentbiosClient({
    apiUrl: pluginConfig.apiUrl,
    defaultUserId: pluginConfig.defaultUserId,
    agentId: ctx?.agentId || COACH_AGENT_ID,
  });
}

const TOOLS = [
  {
    name: "intent_create",
    description:
      "Create an Intentbios intent for the coach. Sends the learner goal to Intentbios. Does not invent a lesson.",
    parameters: objectSchema(
      {
        goal: { type: "string", description: "What the learner wants to accomplish." },
        title: { type: "string", description: "Optional short title." },
        userId: userIdField,
      },
      ["goal"],
    ),
    async run(client, params) {
      return client.intentCreate(params);
    },
  },
  {
    name: "journey_message",
    description:
      "Send an Ask on an existing intent. Intentbios owns the journey reply. Do not write a canned lesson in place of this call.",
    parameters: objectSchema(
      {
        intentId: intentIdField,
        message: { type: "string", description: "The learner or coach message to send as an Ask." },
        userId: userIdField,
      },
      ["intentId", "message"],
    ),
    async run(client, params) {
      return client.journeyMessage(params);
    },
  },
  {
    name: "intent_execute",
    description:
      "Ask Intentbios to execute the current intent step. Sophia proposals stay inside Intentbios.",
    parameters: objectSchema(
      {
        intentId: intentIdField,
        userId: userIdField,
      },
      ["intentId"],
    ),
    async run(client, params) {
      return client.intentExecute(params);
    },
  },
  {
    name: "state_snapshot",
    description: "Read the current Intentbios state snapshot for an intent.",
    parameters: objectSchema(
      {
        intentId: intentIdField,
        userId: userIdField,
      },
      ["intentId"],
    ),
    async run(client, params) {
      return client.stateSnapshot(params);
    },
  },
  {
    name: "lesson_status",
    description:
      "Read lesson status from Intentbios. Lessons are proposed inside Intentbios; this tool does not generate lesson content.",
    parameters: objectSchema(
      {
        intentId: intentIdField,
        userId: userIdField,
      },
      ["intentId"],
    ),
    async run(client, params) {
      return client.lessonStatus(params);
    },
  },
];

export default {
  id: "intentbios",
  name: "Intentbios",
  description: "Create and advance Intentbios intents from the intentbios-coach agent.",
  register(api) {
    for (const tool of TOOLS) {
      api.registerTool((ctx) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_toolCallId, params) {
          try {
            const payload = await tool.run(clientFrom(api, ctx), params || {});
            return toolResult(payload);
          } catch (error) {
            return toolError(error);
          }
        },
      }));
    }
  },
};
