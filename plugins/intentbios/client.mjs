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

const ASK_STATUS_RE =
  /Current step is [\s\S]*?Ask can coach this step; it does not mark it complete\.\s*Current block: [^.]+?\./g;

/** Defense in depth: coach replies should stay a short tutoring turn. */
export const JOURNEY_REPLY_MAX_CHARS = 800;

/**
 * Clip at the last sentence end at or before `max`.
 * If no sentence boundary falls in the latter half of the window, cut on a word.
 */
export function clipAtSentenceBoundary(text, max = JOURNEY_REPLY_MAX_CHARS) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length <= max) return raw;
  const window = raw.slice(0, max);
  const min = Math.floor(max * 0.5);
  let end = -1;
  for (const match of window.matchAll(/[.!?](?=\s|$)/g)) {
    const boundary = match.index + 1;
    if (boundary >= min) end = boundary;
  }
  if (end > 0) return raw.slice(0, end).trim();
  const space = window.lastIndexOf(" ");
  const cut = space >= min ? space : max;
  return raw.slice(0, cut).trim();
}

function stripAskStatusPreamble(text) {
  const raw = String(text || "");
  const stripped = raw.replace(ASK_STATUS_RE, " ");
  if (stripped === raw) return raw.trim();
  return stripped.replace(/\s+/g, " ").trim();
}

function isAskStatusOnlyReply(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (!/Ask can coach this step; it does not mark it complete/.test(raw)) return false;
  return stripAskStatusPreamble(raw).length < 40;
}

function isAcknowledgementReply(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 160) return false;
  if (isAskStatusOnlyReply(raw)) return false;
  return /^(noted|got it|okay|ok|thanks|thank you|understood|acknowledged)\b/i.test(raw);
}

function intentbiosAlreadyCoached(body) {
  return body?.coached === true || body?.hasLessonCoaching === true;
}

function isSubstantiveCoachedReply(body) {
  const raw = String(body?.reply || "").trim();
  if (!intentbiosAlreadyCoached(body) || !raw) return false;
  if (isAskStatusOnlyReply(raw) || isAcknowledgementReply(raw)) return false;
  return true;
}

export function compactJourneyMessage(body, intentId, coachingNote) {
  const rawReply = body?.reply ?? null;
  const intentbiosCoached = intentbiosAlreadyCoached(body);
  const raw = rawReply == null ? "" : String(rawReply);
  let reply = rawReply;

  if (isSubstantiveCoachedReply(body)) {
    // Intentbios already returned the tutoring reply. Do not concatenate the lesson dump.
    const stripped = stripAskStatusPreamble(raw);
    reply = clipAtSentenceBoundary(stripped || raw);
  } else if (isAcknowledgementReply(raw) || (raw && isAskStatusOnlyReply(raw) && !coachingNote)) {
    // Acknowledgements and status-only Asks stay status-only.
    reply = rawReply;
  } else if (coachingNote) {
    // Status preamble is dropped; the frontier note stands alone, clipped.
    reply = clipAtSentenceBoundary(coachingNote);
  } else if (raw) {
    reply = isAskStatusOnlyReply(raw) || isAcknowledgementReply(raw)
      ? rawReply
      : clipAtSentenceBoundary(raw);
  }

  return {
    intentId,
    reply,
    advanced: body?.advanced || [],
    nodeStateChanged: Boolean(body?.nodeStateChanged),
    progress: body?.progress ?? null,
    journeyVersion: body?.journeyVersion ?? null,
    goalId: body?.goalId || null,
    hasLessonCoaching: Boolean(coachingNote) || intentbiosCoached,
    coached: intentbiosCoached || Boolean(coachingNote),
  };
}

function isTeachableLesson(node) {
  const lm = node?.learningMaterial || {};
  if (lm.generatedBy !== "llm") return false;
  const overview = String(lm.overviewMarkdown || "").trim();
  const concepts = Array.isArray(lm.coreConcepts) ? lm.coreConcepts : [];
  if (overview.length >= 24) return true;
  return concepts.some((c) => String(c?.explanation || c?.explanationMarkdown || c?.body || "").trim().length >= 24);
}

function coachingTextFromNode(node) {
  if (!node || !isTeachableLesson(node)) return null;
  const lm = node.learningMaterial || {};
  const overview = String(lm.overviewMarkdown || "").trim().slice(0, 1200);
  const concepts = Array.isArray(lm.coreConcepts) ? lm.coreConcepts : [];
  const conceptBit = concepts
    .slice(0, 3)
    .map((c) => {
      const title = c?.title || c?.name || "Concept";
      const expl = String(c?.explanation || c?.explanationMarkdown || c?.body || "").trim().slice(0, 350);
      return expl ? "**" + title + ":** " + expl : null;
    })
    .filter(Boolean)
    .join("\n\n");
  const parts = [
    "Lesson coaching from Intentbios (generatedBy=llm) for **" + (node.label || node.id) + "**:",
    overview,
    conceptBit,
  ].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Bind Ask coaching to the active frontier STUDY node — never a later ready lesson.
 * Prefer explicit nodeId, then executionState.currentNodeId, then first AVAILABLE/IN_PROGRESS
 * STUDY from journey nodeStates (goal-graph order). Fall back only within that same node.
 */
function coachingNoteFromGoal(goalBody, preferNodeId, frontierHint) {
  const graph = goalBody?.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const candidates = [];
  if (preferNodeId) candidates.push(String(preferNodeId));
  if (frontierHint?.currentNodeId) candidates.push(String(frontierHint.currentNodeId));
  for (const key of frontierHint?.openStudyNodeKeys || []) candidates.push(String(key));

  for (const id of candidates) {
    const node = byId.get(id);
    const note = coachingTextFromNode(node);
    if (note) return note;
  }

  // Last resort: still only use teachable material on an explicitly open STUDY node
  // from goal order — do not pick an arbitrary ready later skill.
  return null;
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
    lessons: nodes.map((node) => {
      const lm = node.learningMaterial || {};
      const concepts = Array.isArray(lm.coreConcepts) ? lm.coreConcepts : [];
      return {
        id: node.id,
        label: node.label,
        lessonStatus: node.lessonStatus || null,
        attempt: node.lessonAttempt?.attempt ?? null,
        generatedBy: lm.generatedBy || null,
        overviewMarkdown:
          node.lessonStatus === "ready" && lm.generatedBy === "llm"
            ? String(lm.overviewMarkdown || "").slice(0, 1200)
            : null,
        conceptTitles: concepts.slice(0, 4).map((c) => c?.title || c?.name).filter(Boolean),
        conceptExcerpts:
          node.lessonStatus === "ready" && lm.generatedBy === "llm"
            ? concepts.slice(0, 2).map((c) => ({
                title: c?.title || c?.name || "Concept",
                explanation: String(c?.explanation || c?.explanationMarkdown || c?.body || "").slice(0, 400),
              }))
            : [],
      };
    }),
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
    let coachingNote = null;
    // A substantive coached reply, or a plain acknowledgement, must not be
    // rebuilt from the open lesson. Status-only Asks still pick up the frontier note.
    const skipLessonNote = isSubstantiveCoachedReply(asked) || isAcknowledgementReply(asked?.reply);
    if (!skipLessonNote) {
      try {
        const intentBody = await call(`/api/intents/${encodeURIComponent(intentId)}`, { method: "GET" });
        const goalId = intentBody?.intent?.goalId || asked?.goalId || args.goalId || "";
        if (goalId) {
          const [goalBody, graphsBody] = await Promise.all([
            call(`/api/goals/${encodeURIComponent(goalId)}`, { method: "GET" }),
            call(`/api/intents/${encodeURIComponent(intentId)}/journey-graphs`, { method: "GET" }).catch(() => null),
          ]);
          const bundle = graphsBody?.bundle || {};
          const nodeStates = bundle.nodeStates || {};
          const goalNodes = Array.isArray(bundle.goalGraph?.nodes) ? bundle.goalGraph.nodes : [];
          const openStudyNodeKeys = goalNodes
            .filter((n) => {
              const st = nodeStates[n.nodeKey]?.state;
              const interaction = n.metadata?.interaction;
              return (st === "AVAILABLE" || st === "IN_PROGRESS") && interaction === "STUDY";
            })
            .map((n) => n.nodeKey);
          // Also honor first open node in goal order when interaction missing
          if (!openStudyNodeKeys.length) {
            for (const n of goalNodes) {
              const st = nodeStates[n.nodeKey]?.state;
              if (st === "AVAILABLE" || st === "IN_PROGRESS") {
                openStudyNodeKeys.push(n.nodeKey);
                break;
              }
            }
          }
          const frontierHint = {
            currentNodeId:
              goalBody?.executionState?.currentNodeId ||
              openStudyNodeKeys[0] ||
              null,
            openStudyNodeKeys,
          };
          coachingNote = coachingNoteFromGoal(
            goalBody,
            args.nodeId || args.nodeKey || null,
            frontierHint,
          );
        }
      } catch (enrichErr) {
        // Keep Ask moving even if lesson enrich fails.
      }
    }
    return compactJourneyMessage(asked, intentId, coachingNote);
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
