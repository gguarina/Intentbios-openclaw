/**
 * HTTP tools the intentbios-coach agent may call.
 * Lesson generation and Ask-complete rules stay inside Intentbios.
 */

export const COACH_TOOL_NAMES = [
  "intent_create",
  "journey_message",
  "intent_execute",
  "state_snapshot",
  "lesson_status",
];

const TOOL_ALIASES = {
  "intent.create": "intent_create",
  "journey.message": "journey_message",
  "journey.ask": "journey_message",
  ask: "journey_message",
  "intent.execute": "intent_execute",
  "state.snapshot": "state_snapshot",
  "lesson.status": "lesson_status",
};

const ACTION_ALIASES = {
  clarify: "clarifyIntent",
  "clarify-intent": "clarifyIntent",
  clarifyintent: "clarifyIntent",
  lock: "lockDecision",
  lockdecision: "lockDecision",
};

export function resolveCoachToolName(name) {
  const raw = String(name || "").trim();
  if (COACH_TOOL_NAMES.includes(raw)) return raw;
  return TOOL_ALIASES[raw] || null;
}

export function resolveIntentbiosUserId({ args, sessionKey, defaultUserId } = {}) {
  const fromArgs = String(args?.userId || "").trim();
  if (fromArgs) return fromArgs;
  const key = String(sessionKey || args?.sessionKey || "");
  const match = key.match(/(?:^|[/:])intentbios-user:([^/:]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return String(defaultUserId || "").trim();
}

function normalizeActionTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return ACTION_ALIASES[raw.toLowerCase()] || raw;
}

function joinUrl(baseUrl, pathname) {
  const base = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("INTENTBIOS_API_URL is not configured");
  }
  return `${base}${pathname}`;
}

async function requestJson(fetchImpl, url, { method, userId, sessionKey, body }) {
  const headers = { Accept: "application/json" };
  if (userId) headers["x-user-id"] = userId;
  if (sessionKey) headers["x-intentbios-session"] = sessionKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok || json?.success === false) {
    const message = json?.error || json?.message || `Intentbios HTTP ${res.status}`;
    const error = new Error(String(message));
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

export function compactIntentCreate(body) {
  return {
    intentId: body?.intent?.id || null,
    goalId: body?.graph?.id || body?.intent?.goalId || null,
    outcomeId: body?.outcome?.id || null,
    toolId: body?.tool?.id || null,
    source: body?.source || null,
    reused: Boolean(body?.reused),
    generationJob: body?.generationJob
      ? { jobId: body.generationJob.jobId, status: body.generationJob.status }
      : null,
  };
}

export function compactJourneyMessage(body, intentId) {
  return {
    intentId,
    reply: body?.reply ?? null,
    advanced: body?.advanced || [],
    nodeStateChanged: Boolean(body?.nodeStateChanged),
    progress: body?.progress ?? null,
    journeyVersion: body?.journeyVersion ?? null,
    goalId: body?.goalId || null,
  };
}

export function compactExecute(body, intentId) {
  const evidence = body?.evidence;
  return {
    intentId,
    duplicate: Boolean(body?.duplicate),
    result: evidence?.result || null,
    evidenceId: evidence?.id || null,
    evidenceType: evidence?.type || null,
    nodeId: evidence?.nodeId || null,
    remediationApplied: Boolean(body?.remediationApplied),
  };
}

export function compactJourneyGraphs(body) {
  const bundle = body?.bundle || body?.journey || body || {};
  const goal = bundle.goalGraph || bundle.goal || {};
  const nodes = Array.isArray(goal.nodes) ? goal.nodes : [];
  const states = bundle.nodeStates || body?.nodeStates || {};
  return {
    intentId: body?.intentId || bundle.intentId || null,
    journeyId: bundle.journeyId || body?.journeyId || null,
    nodes: nodes.map((node) => {
      const nodeKey = node.nodeKey || node.id;
      const stateRecord = states[nodeKey] || {};
      return {
        nodeKey,
        label: node.label || node.metadata?.label || nodeKey,
        state: stateRecord.state || stateRecord.status || node.status || null,
      };
    }),
    progress: body?.progress || bundle.progress || null,
  };
}

export function compactLessonStatus({ intentBody, goalBody, statusBody }) {
  const graph = goalBody?.graph || intentBody?.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return {
    intentId: intentBody?.intent?.id || null,
    goalId: graph.id || intentBody?.intent?.goalId || null,
    generationStatus: statusBody?.generationStatus || graph.generationStatus || null,
    lessons: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      lessonStatus: node.lessonStatus || null,
      attempt: node.lessonAttempt?.attempt ?? null,
    })),
  };
}

export async function executeIntentbiosTool(toolName, args = {}, options = {}) {
  const name = resolveCoachToolName(toolName);
  if (!name) {
    throw new Error(`Unknown Intentbios coach tool: ${toolName}`);
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sessionKey = options.sessionKey || args.sessionKey || "";
  const userId = resolveIntentbiosUserId({
    args,
    sessionKey,
    defaultUserId: options.defaultUserId,
  });
  if (!userId) {
    throw new Error(
      "x-user-id is required. Pass userId or a sessionKey of the form intentbios-user:<id>.",
    );
  }
  const baseUrl = options.baseUrl;
  const call = (pathname, init) =>
    requestJson(fetchImpl, joinUrl(baseUrl, pathname), {
      userId,
      sessionKey,
      ...init,
    });

  if (name === "intent_create") {
    const rawInput = String(args.rawInput || args.topic || "").trim();
    if (!rawInput) throw new Error("rawInput is required");
    const body = { rawInput };
    if (args.hoursPerWeek != null) body.hoursPerWeek = Number(args.hoursPerWeek);
    const created = await call("/api/intents", { method: "POST", body });
    return compactIntentCreate(created);
  }

  if (name === "journey_message") {
    const intentId = String(args.intentId || "").trim();
    const message = String(args.message || "").trim();
    if (!intentId) throw new Error("intentId is required");
    if (!message) throw new Error("message is required");
    const asked = await call(
      `/api/intents/${encodeURIComponent(intentId)}/journey/message`,
      { method: "POST", body: { message, userId } },
    );
    return compactJourneyMessage(asked, intentId);
  }

  if (name === "intent_execute") {
    const intentId = String(args.intentId || "").trim();
    const actionTarget = normalizeActionTarget(args.actionTarget);
    if (!intentId) throw new Error("intentId is required");
    if (!actionTarget) throw new Error("actionTarget is required");
    const payload =
      args.payload && typeof args.payload === "object" ? { ...args.payload } : {};
    const body = { actionTarget, payload, userId };
    if (args.idempotencyKey) body.idempotencyKey = String(args.idempotencyKey);
    const executed = await call(
      `/api/intents/${encodeURIComponent(intentId)}/execute`,
      { method: "POST", body },
    );
    return compactExecute(executed, intentId);
  }

  if (name === "state_snapshot") {
    const intentId = String(args.intentId || "").trim();
    if (!intentId) throw new Error("intentId is required");
    const graphs = await call(
      `/api/intents/${encodeURIComponent(intentId)}/journey-graphs`,
      { method: "GET" },
    );
    return compactJourneyGraphs({ ...graphs, intentId: graphs.intentId || intentId });
  }

  const intentId = String(args.intentId || "").trim();
  if (!intentId) throw new Error("intentId is required");
  const intentBody = await call(`/api/intents/${encodeURIComponent(intentId)}`, {
    method: "GET",
  });
  const goalId = intentBody?.intent?.goalId || intentBody?.graph?.id;
  let goalBody = null;
  let statusBody = null;
  if (goalId) {
    goalBody = await call(`/api/goals/${encodeURIComponent(goalId)}`, { method: "GET" });
    statusBody = await call(`/api/goals/${encodeURIComponent(goalId)}/status`, {
      method: "GET",
    });
  }
  return compactLessonStatus({ intentBody, goalBody, statusBody });
}
