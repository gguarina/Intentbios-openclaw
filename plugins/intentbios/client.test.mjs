import assert from "node:assert/strict";
import test from "node:test";

import { COACH_AGENT_ID, createIntentbiosClient } from "./client.mjs";

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const result = await handler(url, init, calls);
    const body =
      result.body === undefined ? "" : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      async text() {
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

test("intent_create posts the goal and coach agent id", async () => {
  const { fetchImpl, calls } = mockFetch(async () => ({
    status: 201,
    body: { id: "intent_1" },
  }));
  const client = createIntentbiosClient({
    apiUrl: "https://coach.example/",
    defaultUserId: "user-1",
    fetchImpl,
  });
  const result = await client.intentCreate({ goal: "  find a flat  " });
  assert.deepEqual(result, { id: "intent_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://coach.example/api/intents");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    goal: "find a flat",
    agentId: COACH_AGENT_ID,
    userId: "user-1",
  });
});

test("journey_message asks on the intent and does not send lesson text", async () => {
  const { fetchImpl, calls } = mockFetch(async () => ({
    status: 200,
    body: { reply: "What budget?" },
  }));
  const client = createIntentbiosClient({
    apiUrl: "https://coach.example",
    fetchImpl,
    agentId: COACH_AGENT_ID,
  });
  await client.journeyMessage({
    intentId: "intent/1",
    message: "I want two rooms",
    userId: "user-2",
  });
  assert.equal(
    calls[0].url,
    "https://coach.example/api/intents/intent%2F1/messages",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: "I want two rooms",
    agentId: COACH_AGENT_ID,
    kind: "ask",
    userId: "user-2",
  });
  assert.equal(JSON.parse(calls[0].init.body).lesson, undefined);
});

test("intent_execute, state_snapshot, and lesson_status use the intent routes", async () => {
  const { fetchImpl, calls } = mockFetch(async (url, init) => ({
    status: 200,
    body: { url, method: init.method },
  }));
  const client = createIntentbiosClient({
    apiUrl: "https://coach.example",
    defaultUserId: "user-9",
    fetchImpl,
  });
  await client.intentExecute({ intentId: "abc" });
  await client.stateSnapshot({ intentId: "abc" });
  await client.lessonStatus({ intentId: "abc" });
  assert.deepEqual(
    calls.map((call) => `${call.init.method} ${call.url}`),
    [
      "POST https://coach.example/api/intents/abc/execute",
      "GET https://coach.example/api/intents/abc/state?agentId=intentbios-coach&userId=user-9",
      "GET https://coach.example/api/intents/abc/lessons/status?agentId=intentbios-coach&userId=user-9",
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agentId: COACH_AGENT_ID,
    userId: "user-9",
  });
});

test("failed responses raise the status and payload", async () => {
  const { fetchImpl } = mockFetch(async () => ({
    status: 422,
    body: { error: "goal required" },
  }));
  const client = createIntentbiosClient({
    apiUrl: "https://coach.example",
    fetchImpl,
  });
  await assert.rejects(client.intentCreate({ goal: "x", userId: "u" }), (error) => {
    assert.equal(error.status, 422);
    assert.deepEqual(error.payload, { error: "goal required" });
    return true;
  });
});

test("missing apiUrl fails before fetch", async () => {
  const client = createIntentbiosClient({ fetchImpl: async () => {
    throw new Error("should not fetch");
  } });
  await assert.rejects(client.stateSnapshot({ intentId: "abc" }), /apiUrl/);
});
