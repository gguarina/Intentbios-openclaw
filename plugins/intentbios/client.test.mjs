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
  // journey_message may enrich with GET intent/goal/journey-graphs after the Ask.
  const executedCall = seen.find((row) => row.url === "/api/intents/int_1/execute");
  assert.ok(executedCall);
  assert.equal(executedCall.body.actionTarget, "clarifyIntent");
  assert.deepEqual(executedCall.body.payload, { optionId: "learn" });
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

test("status preamble is dropped when coachingNote is present", async () => {
  const { compactJourneyMessage } = await import("./client.mjs");
  const status =
    "Current step is Unit circle (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const note = "Lesson coaching from Intentbios (generatedBy=llm) for **Unit circle**:\n\nThe unit circle maps angle to (cos, sin).";
  const compacted = compactJourneyMessage({ reply: status }, "int_1", note);
  assert.equal(compacted.reply, note);
  assert.equal(compacted.hasLessonCoaching, true);
  assert.doesNotMatch(compacted.reply, /Ask can coach this step/);

  const statusOnly = compactJourneyMessage({ reply: status }, "int_1", null);
  assert.equal(statusOnly.reply, status);
  assert.equal(statusOnly.hasLessonCoaching, false);

  const ack = compactJourneyMessage(
    { reply: "Noted. Next step is still open." },
    "int_1",
    note,
  );
  assert.equal(ack.reply, "Noted. Next step is still open.");
  assert.doesNotMatch(ack.reply, /Lesson coaching from Intentbios/);
});

test("coached short reply is not followed by the lesson dump", async () => {
  const { compactJourneyMessage } = await import("./client.mjs");
  const short = "The unit circle maps angle to cosine and sine on the axes.";
  const status =
    "Current step is Unit circle (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const note = [
    "Lesson coaching from Intentbios (generatedBy=llm) for **Unit circle**:",
    "",
    "The full lesson markdown would be pasted here.",
  ].join("\n");
  const already = compactJourneyMessage(
    { reply: short, coached: true, hasLessonCoaching: true },
    "int_1",
    note,
  );
  assert.equal(already.reply, short);
  assert.equal(already.coached, true);
  assert.doesNotMatch(already.reply, /Lesson coaching from Intentbios/);

  const withPreamble = compactJourneyMessage(
    { reply: `${status}\n\n${short}`, coached: true, hasLessonCoaching: true },
    "int_1",
    note,
  );
  assert.equal(withPreamble.reply, short);
  assert.doesNotMatch(withPreamble.reply, /Ask can coach this step/);
  assert.doesNotMatch(withPreamble.reply, /Lesson coaching from Intentbios/);

  const paragraphs = "First sentence about the unit circle.\n\nSecond sentence stays on its own line.";
  const kept = compactJourneyMessage(
    { reply: paragraphs, coached: true },
    "int_1",
    note,
  );
  assert.equal(kept.reply, paragraphs);
});

test("long coaching note clips on a sentence boundary", async () => {
  const { clipAtSentenceBoundary, compactJourneyMessage, JOURNEY_REPLY_MAX_CHARS } = await import("./client.mjs");
  const sentence = "The unit circle maps an angle to cosine and sine. ";
  const note = `Lesson coaching from Intentbios (generatedBy=llm) for **Unit circle**:\n\n${sentence.repeat(40)}This tail must not survive the clip.`;
  assert.ok(note.length > JOURNEY_REPLY_MAX_CHARS);

  const clipped = clipAtSentenceBoundary(note);
  assert.ok(clipped.length <= JOURNEY_REPLY_MAX_CHARS);
  assert.ok(clipped.length < note.length);
  assert.match(clipped, /\.\s*$/);
  assert.doesNotMatch(clipped, /This tail must not survive/);

  const status =
    "Current step is Unit circle (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const compacted = compactJourneyMessage({ reply: status }, "int_1", note);
  assert.equal(compacted.reply, clipped);
  assert.doesNotMatch(compacted.reply, /Ask can coach this step/);
  assert.match(compacted.reply, /^Lesson coaching from Intentbios/);
});

test("journey_message does not append the lesson after a coached reply", async () => {
  const seen = [];
  const sentence = "Radians measure arc length on a circle of radius one. ";
  const overview = sentence.repeat(40);
  const server = await listen(async (req, res) => {
    seen.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents/int_1/journey/message" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        reply: "Degrees and radians name the same rotation. Multiply by π/180 to convert.",
        coached: true,
        hasLessonCoaching: true,
        advanced: [],
        goalId: "goal_1",
      }));
      return;
    }
    if (req.url === "/api/intents/int_1") {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, intent: { id: "int_1", goalId: "goal_1" } }));
      return;
    }
    if (req.url === "/api/goals/goal_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        executionState: { currentNodeId: "n1" },
        graph: {
          id: "goal_1",
          nodes: [{
            id: "n1",
            label: "Degrees and radians",
            learningMaterial: { generatedBy: "llm", overviewMarkdown: overview, coreConcepts: [] },
          }],
        },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/journey-graphs") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        bundle: {
          goalGraph: { nodes: [{ nodeKey: "n1", metadata: { interaction: "STUDY" } }] },
          nodeStates: { n1: { state: "AVAILABLE" } },
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const asked = await executeIntentbiosTool(
      "journey_message",
      { intentId: "int_1", message: "How do I convert degrees?", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(
      asked.reply,
      "Degrees and radians name the same rotation. Multiply by π/180 to convert.",
    );
    assert.doesNotMatch(asked.reply, /Lesson coaching from Intentbios/);
    assert.equal(seen.includes("/api/goals/goal_1"), false);
  } finally {
    await server.close();
  }
});

test("status-only ask is a clipped frontier note and acknowledgements stay put", async () => {
  const { JOURNEY_REPLY_MAX_CHARS } = await import("./client.mjs");
  const sentence = "Radians measure arc length on a circle of radius one. ";
  const overview = sentence.repeat(40);
  const status =
    "Current step is Degrees and radians (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents/int_1/journey/message" && req.method === "POST") {
      const reply = body?.message === "ack" ? "Noted. Next step is still open." : status;
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        reply,
        coached: false,
        hasLessonCoaching: false,
        goalId: "goal_1",
      }));
      return;
    }
    if (req.url === "/api/intents/int_1") {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, intent: { id: "int_1", goalId: "goal_1" } }));
      return;
    }
    if (req.url === "/api/goals/goal_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        executionState: { currentNodeId: "n1" },
        graph: {
          id: "goal_1",
          nodes: [{
            id: "n1",
            label: "Degrees and radians",
            learningMaterial: { generatedBy: "llm", overviewMarkdown: overview, coreConcepts: [] },
          }],
        },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/journey-graphs") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        bundle: {
          goalGraph: { nodes: [{ nodeKey: "n1", metadata: { interaction: "STUDY" } }] },
          nodeStates: { n1: { state: "AVAILABLE" } },
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const asked = await executeIntentbiosTool(
      "journey_message",
      { intentId: "int_1", message: "coach this step", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.match(asked.reply, /^Lesson coaching from Intentbios \(generatedBy=llm\)/);
    assert.doesNotMatch(asked.reply, /Ask can coach this step/);
    assert.ok(asked.reply.length <= JOURNEY_REPLY_MAX_CHARS);
    assert.ok(asked.reply.length < overview.length);
    assert.match(asked.reply, /\.$/);
    assert.equal(asked.coachCard, undefined);

    const ack = await executeIntentbiosTool(
      "journey_message",
      { intentId: "int_1", message: "ack", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(ack.reply, "Noted. Next step is still open.");
    assert.doesNotMatch(ack.reply, /Lesson coaching from Intentbios/);
  } finally {
    await server.close();
  }
});

test("message ok keeps the status-only Intentbios reply", async () => {
  const { compactJourneyMessage } = await import("./client.mjs");
  const status =
    "Current step is Degrees and radians (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const note = "Lesson coaching from Intentbios (generatedBy=llm) for **Degrees and radians**:\n\nRadians measure arc length.";
  const kept = compactJourneyMessage(
    { reply: status, coached: false, hasLessonCoaching: false },
    "int_1",
    note,
    { userMessage: "ok" },
  );
  assert.equal(kept.reply, status);
  assert.equal(kept.coached, false);
  assert.equal(kept.hasLessonCoaching, false);
  assert.doesNotMatch(kept.reply, /Lesson coaching from Intentbios/);

  const seen = [];
  const sentence = "Radians measure arc length on a circle of radius one. ";
  const overview = sentence.repeat(40);
  const server = await listen(async (req, res) => {
    seen.push(req.url);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents/int_1/journey/message" && req.method === "POST") {
      assert.equal(body?.message, "ok");
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        reply: status,
        coached: false,
        hasLessonCoaching: false,
        goalId: "goal_1",
      }));
      return;
    }
    if (req.url === "/api/intents/int_1") {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, intent: { id: "int_1", goalId: "goal_1" } }));
      return;
    }
    if (req.url === "/api/goals/goal_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        executionState: { currentNodeId: "n1" },
        graph: {
          id: "goal_1",
          nodes: [{
            id: "n1",
            label: "Degrees and radians",
            learningMaterial: { generatedBy: "llm", overviewMarkdown: overview, coreConcepts: [] },
          }],
        },
      }));
      return;
    }
    if (req.url === "/api/intents/int_1/journey-graphs") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        bundle: {
          goalGraph: { nodes: [{ nodeKey: "n1", metadata: { interaction: "STUDY" } }] },
          nodeStates: { n1: { state: "AVAILABLE" } },
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const asked = await executeIntentbiosTool(
      "journey_message",
      { intentId: "int_1", message: "ok", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(asked.reply, status);
    assert.equal(asked.coached, false);
    assert.equal(asked.hasLessonCoaching, false);
    assert.doesNotMatch(asked.reply, /Lesson coaching from Intentbios/);
    assert.equal(asked.coachCard, undefined);
    assert.equal(seen.includes("/api/goals/goal_1"), false);
  } finally {
    await server.close();
  }
});

test("journey message forwards coachCard and rejects a lesson dump", async () => {
  const { compactJourneyMessage } = await import("./client.mjs");
  const reply = "Markdown coaching for the learner question.";
  const card = {
    summary: "One or two sentences.",
    deepLink:
      "https://coachapp-production-0a92.up.railway.app/?intentId=intent_example&node=some_node",
    suggestedReplies: ["How do I start this step?", "Give me a hint", "I finished this step"],
  };
  const status =
    "Current step is Unit circle (STUDY). This step stays with you. Ask can coach this step; it does not mark it complete. Current block: Overview.";
  const lessonDump =
    "LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK. The full lesson body, uiSchema, and raw HTML stay in Intentbios.";
  const note = `Lesson coaching from Intentbios (generatedBy=llm) for **Unit circle**:\n\n${lessonDump}`;
  const kept = compactJourneyMessage(
    {
      reply: `${status}\n\n${reply}`,
      coachCard: {
        ...card,
        lessonBody: lessonDump,
        uiSchema: { type: "Lesson", html: "<article>raw lesson</article>" },
        html: "<article>raw lesson</article>",
        overviewMarkdown: lessonDump,
      },
      learningMaterial: { overviewMarkdown: lessonDump },
      uiSchema: { type: "Lesson" },
    },
    "intent_example",
    note,
  );
  assert.equal(kept.reply, reply);
  assert.deepEqual(kept.coachCard, card);
  assert.doesNotMatch(kept.reply, /Lesson coaching from Intentbios/);
  assert.doesNotMatch(kept.reply, /Ask can coach this step/);
  assert.doesNotMatch(JSON.stringify(kept), /LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(JSON.stringify(kept), /uiSchema/);
  assert.doesNotMatch(JSON.stringify(kept), /<article>/);

  const coachingWithoutCard = compactJourneyMessage(
    { reply: `${status}\n\n${reply}` },
    "intent_example",
    note,
  );
  assert.equal(coachingWithoutCard.reply, reply);
  assert.equal(coachingWithoutCard.coachCard, undefined);
  assert.doesNotMatch(coachingWithoutCard.reply, /Lesson coaching from Intentbios/);

  const omitted = compactJourneyMessage({ reply: status }, "intent_example", null);
  assert.equal(omitted.coachCard, undefined);

  const seen = [];
  const sentence = "Radians measure arc length on a circle of radius one. ";
  const overview = `${lessonDump} ${sentence.repeat(40)}`;
  const server = await listen(async (req, res) => {
    seen.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents/intent_example/journey/message" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        intentId: "intent_example",
        reply,
        coachCard: {
          ...card,
          lessonBody: lessonDump,
          uiSchema: { html: "<article>raw lesson</article>" },
          html: "<article>raw lesson</article>",
          suggestedReplies: [
            ...card.suggestedReplies,
            { html: "<article>raw lesson</article>" },
          ],
        },
        learningMaterial: { overviewMarkdown: lessonDump, generatedBy: "llm" },
        goalId: "goal_1",
      }));
      return;
    }
    if (req.url === "/api/intents/intent_example") {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, intent: { id: "intent_example", goalId: "goal_1" } }));
      return;
    }
    if (req.url === "/api/goals/goal_1") {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        executionState: { currentNodeId: "n1" },
        graph: {
          id: "goal_1",
          nodes: [{
            id: "n1",
            label: "Unit circle",
            learningMaterial: {
              generatedBy: "llm",
              overviewMarkdown: overview,
              coreConcepts: [{ title: "Dump", explanation: lessonDump }],
            },
          }],
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const asked = await executeIntentbiosTool(
      "journey_message",
      { intentId: "intent_example", message: "How do I start this step?", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(asked.reply, reply);
    assert.deepEqual(asked.coachCard, card);
    assert.equal(asked.intentId, "intent_example");
    assert.doesNotMatch(asked.reply, /Lesson coaching from Intentbios/);
    assert.doesNotMatch(JSON.stringify(asked), /LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(JSON.stringify(asked), /uiSchema/);
    assert.doesNotMatch(JSON.stringify(asked), /<article>/);
    assert.equal(seen.includes("/api/goals/goal_1"), false);
  } finally {
    await server.close();
  }
});

test("intent create forwards coachCard and does not invent one", async () => {
  const { compactIntentCreate } = await import("./client.mjs");
  const card = {
    summary: "One or two sentences.",
    deepLink:
      "https://coachapp-production-0a92.up.railway.app/?intentId=intent_example&node=some_node",
    suggestedReplies: ["How do I start this step?", "Give me a hint", "I finished this step"],
  };
  const lessonDump = "LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK";
  const withCard = compactIntentCreate({
    intent: { id: "intent_example", goalId: "goal_1" },
    graph: { id: "goal_1" },
    source: "catalog",
    coachCard: {
      ...card,
      lessonBody: lessonDump,
      uiSchema: { type: "Lesson" },
      html: "<article>raw lesson</article>",
    },
    learningMaterial: { overviewMarkdown: lessonDump },
  });
  assert.equal(withCard.intentId, "intent_example");
  assert.deepEqual(withCard.coachCard, card);
  assert.doesNotMatch(JSON.stringify(withCard), /LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(JSON.stringify(withCard), /uiSchema/);
  assert.doesNotMatch(JSON.stringify(withCard), /<article>/);

  const withoutCard = compactIntentCreate({
    intent: { id: "intent_example" },
    graph: { id: "goal_1" },
    learningMaterial: { overviewMarkdown: lessonDump },
  });
  assert.equal(withoutCard.coachCard, undefined);
  assert.doesNotMatch(JSON.stringify(withoutCard), /LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK/);

  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intents" && req.method === "POST") {
      const payload = {
        success: true,
        intent: { id: "intent_example", goalId: "goal_1" },
        graph: { id: "goal_1" },
        source: "catalog",
      };
      if (body.rawInput === "with card") {
        payload.coachCard = {
          ...card,
          lessonBody: lessonDump,
          uiSchema: { html: "<article>raw lesson</article>" },
          html: "<article>raw lesson</article>",
        };
        payload.reply = "Markdown coaching for the learner question.";
      }
      res.writeHead(201);
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });

  try {
    const created = await executeIntentbiosTool(
      "intent_create",
      { rawInput: "with card", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.deepEqual(created.coachCard, card);
    assert.equal(created.intentId, "intent_example");
    assert.doesNotMatch(JSON.stringify(created), /LESSON_DUMP_OVERVIEW_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(JSON.stringify(created), /uiSchema/);
    assert.doesNotMatch(JSON.stringify(created), /<article>/);

    const plain = await executeIntentbiosTool(
      "intent_create",
      { rawInput: "no card", userId: "grok-bot" },
      { baseUrl: server.baseUrl },
    );
    assert.equal(plain.coachCard, undefined);
    assert.equal(plain.intentId, "intent_example");
  } finally {
    await server.close();
  }
});
