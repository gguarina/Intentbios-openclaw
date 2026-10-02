/**
 * HTTP client for the Intentbios coach tools.
 *
 * Sophia stays inside Intentbios and only proposes experiences. These calls
 * never embed lesson text; lesson_status returns whatever Intentbios sends.
 */

export const COACH_AGENT_ID = "intentbios-coach";
export const SOPHIA_AGENT_ID = "intentbios-sophia";

export const COACH_TOOL_NAMES = Object.freeze([
  "intent_create",
  "journey_message",
  "intent_execute",
  "state_snapshot",
  "lesson_status",
]);

function trimBase(apiUrl) {
  return String(apiUrl || "").trim().replace(/\/+$/, "");
}

function encodeId(value) {
  return encodeURIComponent(String(value));
}

function withQuery(pathname, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `${pathname}?${text}` : pathname;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function createIntentbiosClient(options = {}) {
  const apiUrl = trimBase(options.apiUrl);
  const defaultUserId = options.defaultUserId?.trim?.()
    ? options.defaultUserId.trim()
    : options.defaultUserId || undefined;
  const agentId = options.agentId || COACH_AGENT_ID;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  function resolveUserId(input) {
    const explicit = input?.userId;
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    if (typeof defaultUserId === "string" && defaultUserId.trim()) {
      return defaultUserId.trim();
    }
    return undefined;
  }

  async function request(method, pathname, body) {
    if (!apiUrl) {
      throw new Error("Intentbios apiUrl is not configured");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("Intentbios fetch implementation is missing");
    }
    const response = await fetchImpl(`${apiUrl}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      const error = new Error(
        `Intentbios ${method} ${pathname} failed (${response.status})`,
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return {
    agentId,
    intentCreate(input = {}) {
      const goal = String(input.goal || "").trim();
      if (!goal) throw new Error("intent_create requires goal");
      const body = { goal, agentId };
      const userId = resolveUserId(input);
      if (userId) body.userId = userId;
      if (typeof input.title === "string" && input.title.trim()) {
        body.title = input.title.trim();
      }
      return request("POST", "/api/intents", body);
    },
    journeyMessage(input = {}) {
      const intentId = String(input.intentId || "").trim();
      const message = String(input.message || "").trim();
      if (!intentId) throw new Error("journey_message requires intentId");
      if (!message) throw new Error("journey_message requires message");
      const body = { message, agentId, kind: "ask" };
      const userId = resolveUserId(input);
      if (userId) body.userId = userId;
      return request("POST", `/api/intents/${encodeId(intentId)}/messages`, body);
    },
    intentExecute(input = {}) {
      const intentId = String(input.intentId || "").trim();
      if (!intentId) throw new Error("intent_execute requires intentId");
      const body = { agentId };
      const userId = resolveUserId(input);
      if (userId) body.userId = userId;
      return request("POST", `/api/intents/${encodeId(intentId)}/execute`, body);
    },
    stateSnapshot(input = {}) {
      const intentId = String(input.intentId || "").trim();
      if (!intentId) throw new Error("state_snapshot requires intentId");
      const pathname = withQuery(`/api/intents/${encodeId(intentId)}/state`, {
        agentId,
        userId: resolveUserId(input),
      });
      return request("GET", pathname);
    },
    lessonStatus(input = {}) {
      const intentId = String(input.intentId || "").trim();
      if (!intentId) throw new Error("lesson_status requires intentId");
      const pathname = withQuery(
        `/api/intents/${encodeId(intentId)}/lessons/status`,
        {
          agentId,
          userId: resolveUserId(input),
        },
      );
      return request("GET", pathname);
    },
  };
}
