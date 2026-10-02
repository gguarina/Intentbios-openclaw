import assert from "node:assert/strict";
import test from "node:test";

import {
  executeIntentbiosTool,
  resolveCoachToolName,
  resolveIntentbiosUserId,
} from "./client.mjs";

const BASE = "https://coachapp-production-0a92.up.railway.app";

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes.find((entry) => entry.method === init.method && entry.url === url);
    if (!route) {
      return {
        ok: false,
        status: 404,
        async text() {
          return JSON.stringify({ error: `unmocked ${init.method} ${url}` });
        },
      };
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      async text() {
        return route.body === undefined ? "" : JSON.stringify(route.body);
      },
    };
  };
  return { fetchImpl, calls };
}

test("resolves tool aliases onto the five coach tools", () => {
  assert.equal(resolveCoachToolName("intent.create"), "intent_create");
  assert.equal(resolveCoachToolName("journey.message"), "journey_message");
  assert.equal(resolveCoachToolName("journey.ask"), "journey_message");
  assert.equal(resolveCoachToolName("ask"), "journey_message");
  assert.equal(resolveCoachToolName("intent.execute"), "intent_execute");
  assert.equal(resolveCoachToolName("state.snapshot"), "state_snapshot");
  assert.equal(resolveCoachToolName("lesson.status"), "lesson_status");
  assert.equal(resolveCoachToolName("intent_create"), "intent_create");
  assert.equal(resolveCoachToolName("nope"), null);
});

test("resolves user id from args, sessionKey, then the default", () => {
  assert.equal(
    resolveIntentbiosUserId({
      args: { userId: " from-args " },
      sessionKey: "agent:main:intentbios-user:from-session",
      defaultUserId: "from-default",
    }),
    "from-args",
  );
  assert.equal(
    resolveIntentbiosUserId({
      sessionKey: "agent/intentbios-coach/intentbios-user:user%2F7",
      defaultUserId: "from-default",
    }),
    "user/7",
  );
  assert.equal(
    resolveIntentbiosUserId({ defaultUserId: " from-default " }),
    "from-default",
  );
  assert.equal(resolveIntentbiosUserId({}), "");
});

test("intent_create posts rawInput and x-user-id", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "POST",
      url: `${BASE}/api/intents`,
      status: 201,
      body: {
        intent: { id: "intent_1", goalId: "goal_1" },
        source: "coach",
        reused: false,
      },
    },
  ]);
  const result = await executeIntentbiosTool(
    "intent.create",
    { rawInput: " find a flat ", hoursPerWeek: 4 },
    { baseUrl: `${BASE}/`, defaultUserId: "user-1", fetchImpl },
  );
  assert.deepEqual(result, {
    intentId: "intent_1",
    goalId: "goal_1",
    outcomeId: null,
    toolId: null,
    source: "coach",
    reused: false,
    generationJob: null,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { rawInput: "find a flat", hoursPerWeek: 4 });
  assert.equal(calls[0].init.headers["x-user-id"], "user-1");
  assert.equal(calls[0].body.goal, undefined);
});

test("journey_message posts to /journey/message with message and userId", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "POST",
      url: `${BASE}/api/intents/intent%2F1/journey/message`,
      status: 200,
      body: { reply: "What budget?", advanced: ["node-a"], goalId: "goal_1" },
    },
  ]);
  const result = await executeIntentbiosTool(
    "ask",
    { intentId: "intent/1", message: "two rooms", userId: "user-2" },
    { baseUrl: BASE, fetchImpl, sessionKey: "sess-9" },
  );
  assert.equal(result.reply, "What budget?");
  assert.equal(result.intentId, "intent/1");
  assert.deepEqual(calls[0].body, { message: "two rooms", userId: "user-2" });
  assert.equal(calls[0].init.headers["x-user-id"], "user-2");
  assert.equal(calls[0].init.headers["x-intentbios-session"], "sess-9");
  assert.equal(calls[0].url.includes("/messages"), false);
  assert.equal(calls[0].body.kind, undefined);
});

test("intent_execute aliases clarify and lock and sends payload", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "POST",
      url: `${BASE}/api/intents/abc/execute`,
      status: 200,
      body: { evidence: { id: "ev1", result: "ok", type: "clarify", nodeId: "n1" } },
    },
    {
      method: "POST",
      url: `${BASE}/api/intents/abc/execute`,
      status: 200,
      body: { duplicate: true, evidence: { result: "locked" } },
    },
  ]);
  await executeIntentbiosTool(
    "intent.execute",
    {
      intentId: "abc",
      actionTarget: "clarify",
      payload: { note: "budget" },
      idempotencyKey: "k1",
      userId: "user-3",
    },
    { baseUrl: BASE, fetchImpl },
  );
  await executeIntentbiosTool(
    "intent_execute",
    { intentId: "abc", actionTarget: "lock", userId: "user-3" },
    { baseUrl: BASE, fetchImpl },
  );
  assert.deepEqual(calls[0].body, {
    actionTarget: "clarifyIntent",
    payload: { note: "budget" },
    userId: "user-3",
    idempotencyKey: "k1",
  });
  assert.equal(calls[1].body.actionTarget, "lockDecision");
  assert.deepEqual(calls[1].body.payload, {});
  assert.equal(calls[0].init.headers["x-user-id"], "user-3");
});

test("state_snapshot reads journey-graphs", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "GET",
      url: `${BASE}/api/intents/abc/journey-graphs`,
      status: 200,
      body: {
        journeyId: "j1",
        bundle: {
          goalGraph: { nodes: [{ nodeKey: "study", label: "Study" }] },
          nodeStates: { study: { state: "ACTIVE" } },
        },
      },
    },
  ]);
  const result = await executeIntentbiosTool(
    "state.snapshot",
    { intentId: "abc" },
    {
      baseUrl: BASE,
      fetchImpl,
      sessionKey: "agent:intentbios-coach:intentbios-user:user-4",
    },
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.endsWith("/journey-graphs"), true);
  assert.equal(calls[0].url.includes("/state"), false);
  assert.equal(calls[0].init.headers["x-user-id"], "user-4");
  assert.deepEqual(result.nodes, [{ nodeKey: "study", label: "Study", state: "ACTIVE" }]);
  assert.equal(result.intentId, "abc");
});

test("lesson_status reads the intent, then the goal and goal status", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "GET",
      url: `${BASE}/api/intents/abc`,
      status: 200,
      body: { intent: { id: "abc", goalId: "goal 1" } },
    },
    {
      method: "GET",
      url: `${BASE}/api/goals/goal%201`,
      status: 200,
      body: {
        graph: {
          id: "goal 1",
          nodes: [{ id: "n1", label: "Intro", lessonStatus: "ready", lessonAttempt: { attempt: 2 } }],
        },
      },
    },
    {
      method: "GET",
      url: `${BASE}/api/goals/goal%201/status`,
      status: 200,
      body: { generationStatus: "ready" },
    },
  ]);
  const result = await executeIntentbiosTool(
    "lesson.status",
    { intentId: "abc", userId: "user-5" },
    { baseUrl: BASE, fetchImpl },
  );
  assert.deepEqual(
    calls.map((call) => `${call.init.method} ${call.url}`),
    [
      `GET ${BASE}/api/intents/abc`,
      `GET ${BASE}/api/goals/goal%201`,
      `GET ${BASE}/api/goals/goal%201/status`,
    ],
  );
  assert.equal(calls.some((call) => call.url.includes("/lessons/status")), false);
  assert.deepEqual(result, {
    intentId: "abc",
    goalId: "goal 1",
    generationStatus: "ready",
    lessons: [{ id: "n1", label: "Intro", lessonStatus: "ready", attempt: 2 }],
  });
  for (const call of calls) {
    assert.equal(call.init.headers["x-user-id"], "user-5");
  }
});

test("HTTP failures surface status and body", async () => {
  const { fetchImpl } = mockFetch([
    {
      method: "POST",
      url: `${BASE}/api/intents`,
      status: 422,
      body: { error: "rawInput required" },
    },
  ]);
  await assert.rejects(
    executeIntentbiosTool(
      "intent_create",
      { rawInput: "x", userId: "u" },
      { baseUrl: BASE, fetchImpl },
    ),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.message, "rawInput required");
      assert.deepEqual(error.body, { error: "rawInput required" });
      return true;
    },
  );
});

test("missing user id fails before fetch", async () => {
  let fetched = false;
  await assert.rejects(
    executeIntentbiosTool(
      "state_snapshot",
      { intentId: "abc" },
      {
        baseUrl: BASE,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("should not fetch");
        },
      },
    ),
    /x-user-id is required/,
  );
  assert.equal(fetched, false);
});
