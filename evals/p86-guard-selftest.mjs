#!/usr/bin/env node
// P8.6 guard self-test — proves the card-quality checks and the client-payload leak probe can FAIL.
// A guard that cannot fail is not a guard. This never touches production: a local stub speaks the
// Intentbios HTTP shape and the module's own deterministicChecks()/runGolden() run unchanged against it.
// Run: node evals/p86-guard-selftest.mjs   (exit 0 = all cases behave, exit 1 = a case did not)
import http from "node:http";
import assert from "node:assert/strict";
import { deterministicChecks, runGolden } from "./coach-golden.mjs";

// The judge would call the model on every turn; the checks are what we test here, so turn it off.
delete process.env.DEEPSEEK_API_KEY;

const GENERIC_TRIO = ["What should I do on this step?", "I'm stuck", "Explain this step simply"];
const DEEP_LINK = "https://coachapp.example/?intentId=guest_selftest&node=n1";
const STATUS_LINE = "Search for an apartment is the open step.";
const COACHING = "Start by searching linkedin.com and indeed.com for the job, then we rank the listings.";

const card = (summary, replies = GENERIC_TRIO) => ({ summary, deepLink: DEEP_LINK, suggestedReplies: replies });

function startStub({ journey }) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && req.url === "/api/intents") return send(200, { intentId: "guest_selftest" });
    // P10.8: the golden harness now waits for the fresh intent to be a
    // coachable skill-graph journey, so the stub speaks those two reads.
    if (req.method === "GET" && req.url.includes("/journey-graphs")) {
      return send(200, {
        bundle: { goalGraph: { nodes: [{ nodeKey: "n1", metadata: { journeySource: "skill_graph" } }] } },
        openStep: { nodeKey: "n1" },
      });
    }
    if (req.method === "GET" && req.url.startsWith("/api/intents/")) {
      return send(200, {
        graph: { nodes: [{ id: "n1", status: "ready", lessonStatus: "ready", learningMaterial: { generatedBy: "llm" } }] },
      });
    }
    if (req.url.includes("/journey/message")) return send(200, journey);
    if (req.url.endsWith("/invoke")) return send(200, { output: { reply: "ok", coachCard: card(journey?.coachCard?.summary || COACHING) } });
    return send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
async function runCase(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (err) { results.push(`FAIL ${name} — ${err.message}`); }
}

// 1. The card-quality checks reject a status-line summary and the generic trio, and accept a real card.
await runCase("checks: status-line card is rejected", () => {
  const c = deterministicChecks({ id: "t", message: "x" }, { reply: "ok", path: "intentbios", coachCard: card(STATUS_LINE) }, []);
  assert.equal(c.summaryNotStatusLine, false, "summaryNotStatusLine should be false for a status line");
  assert.equal(c.repliesNotGeneric, false, "repliesNotGeneric should be false for the generic trio");
});
await runCase("checks: coaching card with lesson replies is accepted", () => {
  const c = deterministicChecks({ id: "t", message: "x" }, { reply: "ok", path: "intentbios", coachCard: card(COACHING, ["45000 euros", "50000 euros"]) }, []);
  assert.equal(c.summaryNotStatusLine, true);
  assert.equal(c.repliesNotGeneric, true);
});

// 2. The live probe FAILS on a payload that still carries the lesson and the step contract.
await runCase("probe: leaking payload (lessonBody + contract) FAILS", async () => {
  const { server, url } = await startStub({ journey: { reply: "r", coachCard: card(COACHING, ["45000 euros"]), lessonBody: { body: "raw lesson" }, contract: "intentbios-contract: {\"step\":{}}" } });
  try {
    process.env.INTENTBIOS_API_URL = url;
    const run = await runGolden({ baseline: null });
    console.log(`    probe → ${JSON.stringify(run.payloadProbe)}`);
    assert.equal(run.payloadProbe.ran, true);
    assert.equal(run.payloadProbe.hasLessonBody, true, "lessonBody should be detected");
    assert.equal(run.payloadProbe.hasContract, true, "intentbios-contract should be detected");
    assert.equal(run.payloadProbe.pass, false, "probe must FAIL on a leaking payload");
  } finally { server.close(); }
});

// 3. The live probe FAILS on a clean payload whose card summary is still the status line.
await runCase("probe: status-line card FAILS", async () => {
  const { server, url } = await startStub({ journey: { reply: "r", coachCard: card(STATUS_LINE, ["45000 euros"]) } });
  try {
    process.env.INTENTBIOS_API_URL = url;
    const run = await runGolden({ baseline: null });
    assert.equal(run.payloadProbe.summaryIsStatusLine, true, "status line should be detected");
    assert.equal(run.payloadProbe.pass, false, "probe must FAIL on a status-line summary");
    // and the same bad card is caught on the golden turns themselves
    assert.equal(run.turns[0].checks.summaryNotStatusLine, false, "the golden turn should flag the status line");
  } finally { server.close(); }
});

// 4. The live probe PASSES on a coaching card with lesson-derived replies and no lesson in the payload.
await runCase("probe: clean coaching payload PASSES", async () => {
  const { server, url } = await startStub({ journey: { reply: "r", coachCard: card(COACHING, ["45000 euros", "50000 euros"]) } });
  try {
    process.env.INTENTBIOS_API_URL = url;
    const run = await runGolden({ baseline: null });
    assert.equal(run.payloadProbe.pass, true, "probe must PASS on a clean payload");
  } finally { server.close(); }
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} case(s) did not behave as expected` : "\nall guard cases behave as expected");
process.exit(failed ? 1 : 0);
