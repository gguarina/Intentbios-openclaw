import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { executeIntentbiosTool } from "./client.mjs";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("smoke: create an intent then send an Ask against mocked Intentbios", async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({
      method: req.method,
      url: req.url,
      userId: req.headers["x-user-id"],
      session: req.headers["x-intentbios-session"],
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents" && req.method === "POST") {
      res.writeHead(201);
      res.end(JSON.stringify({
        success: true,
        intent: { id: "int_1", goalId: "goal_1" },
        graph: { id: "goal_1" },
        source: "catalog",
        generationJob: { jobId: "job_1", status: "running" },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/journey/message" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        reply: "Noted. Next step is still open.",
        advanced: [],
        nodeStateChanged: false,
        progress: { completed: 0, total: 3 },
        journeyVersion: 2,
        goalId: "goal_1",
        skillGraph: { nodes: [{ learningMaterial: { title: "do not leak" } }] },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/execute" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        evidence: { id: "ev_1", result: "passed", type: "COMPLETION", nodeId: "clarify" },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/journey-graphs") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        bundle: {
          journeyId: "jrn_1",
          goalGraph: { nodes: [{ nodeKey: "ask", label: "Ask", status: "ready" }] },
          nodeStates: { ask: { state: "in_progress" } },
        },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        intent: { id: "int_1", goalId: "goal_1" },
        graph: { id: "goal_1", nodes: [] },
      }));
      return;
    }
    if (req.url === "/api/goals/goal_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        graph: {
          id: "goal_1",
          generationStatus: "lessons_ready",
          nodes: [{
            id: "n1",
            label: "Ownership",
            lessonStatus: "ready",
            lessonAttempt: { attempt: 2 },
            learningMaterial: { title: "canned lesson must not leave Intentbios" },
          }],
        },
      }));
      return;
    }
    if (req.url === "/api/goals/goal_1/status") {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, generationStatus: "lessons_ready" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const created = await executeIntentbiosTool(
      "intent.create",
      { rawInput: "Learn enough Rust to write a CLI", hoursPerWeek: 4 },
      { baseUrl: server.baseUrl, sessionKey: "intentbios-user:grok-bot" },
    );
    assert.equal(created.intentId, "int_1");
    assert.equal(created.goalId, "goal_1");
    assert.equal(created.generationJob.status, "running");

    const asked = await executeIntentbiosTool(
      "journey_message",
      { intentId: created.intentId, message: "I can study 4 hours this week", userId: "grok-bot" },
      { baseUrl: server.baseUrl, sessionKey: "intentbios-user:grok-bot" },
    );
    assert.equal(asked.reply, "Noted. Next step is still open.");
    assert.equal(asked.skillGraph, undefined);

    const executed = await executeIntentbiosTool(
      "intent_execute",
      {
        intentId: "int_1",
        actionTarget: "clarify",
        userId: "grok-bot",
        payload: { optionId: "learn" },
      },
      { baseUrl: server.baseUrl },
    );
    assert.equal(executed.result, "passed");

    const snapshot = await executeIntentbiosTool(
      "state.snapshot",
      { intentId: "int_1", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(snapshot.journeyId, "jrn_1");
    assert.equal(snapshot.nodes[0].state, "in_progress");

    const lessons = await executeIntentbiosTool(
      "lesson.status",
      { intentId: "int_1", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(lessons.lessons[0].lessonStatus, "ready");
    assert.equal(JSON.stringify(lessons).includes("canned lesson"), false);
  } finally {
    await server.close();
  }

  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/api/intents");
  assert.equal(seen[0].userId, "grok-bot");
  assert.equal(seen[0].session, "intentbios-user:grok-bot");
  assert.equal(seen[0].body.rawInput, "Learn enough Rust to write a CLI");
  assert.equal(seen[1].url, "/api/intents/int_1/journey/message");
  assert.equal(seen[1].body.message, "I can study 4 hours this week");
  assert.equal(seen[2].body.actionTarget, "clarifyIntent");
  assert.deepEqual(seen[2].body.payload, { optionId: "learn" });
});

test("missing user id is rejected before any HTTP call", async () => {
  await assert.rejects(
    () => executeIntentbiosTool("intent_create", { rawInput: "hello" }, {
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: async () => {
        throw new Error("network should not be called");
      },
    }),
    /x-user-id is required/,
  );
});

test("live smoke", { skip: !process.env.INTENTBIOS_SMOKE_URL }, async () => {
  const userId = process.env.INTENTBIOS_SMOKE_USER || `smoke_${Date.now()}`;
  const created = await executeIntentbiosTool(
    "intent_create",
    { rawInput: "Learn enough Rust to write a CLI", userId },
    { baseUrl: process.env.INTENTBIOS_SMOKE_URL },
  );
  assert.ok(created.intentId);
  const asked = await executeIntentbiosTool(
    "journey_message",
    { intentId: created.intentId, message: "I can study 4 hours this week", userId },
    { baseUrl: process.env.INTENTBIOS_SMOKE_URL },
  );
  assert.equal(typeof asked.reply, "string");
});
