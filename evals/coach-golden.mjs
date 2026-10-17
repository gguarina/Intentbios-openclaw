#!/usr/bin/env node
// Replays the coach golden set on gustavo-test, scores each turn (deterministic checks + flash judge,
// thinking off) and writes a run file. `--baseline` stores the run as the baseline. Never prints secrets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_DIR = process.env.EVAL_DIR || "/data/workspace/evals";
export const BASELINE = path.join(EVAL_DIR, "coach-baseline.json");
const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./golden.json", import.meta.url)), "utf8"));
const GENERIC = new Set(["what should i do on this step?", "i'm stuck", "explain this step simply", "i am stuck"]);
const JUDGE_MODEL = "deepseek-v4-flash";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüß ]+/g, " ").replace(/\s+/g, " ").trim();
const questions = (s) => (String(s || "").match(/[^.!?\n]*\?/g) || []).map(norm).filter(Boolean);
/** The condition a question names ("What size should I use…" -> "size"). */
const conditionKey = (question) => {
  const match = String(question || "").match(/what\s+(.+?)\s+should i use\b/);
  return match ? match[1].replace(/\bfor example\b.*$/, "").trim() : String(question || "").trim();
};
function similar(a, b) {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}
const LISTING = /(immobilienscout24|wg-gesucht|immowelt|kleinanzeigen|immonet)\.de\/\S+|\bexpos[eé]\/?\d{5,}|\d{3,4}\s?(€|eur)\b.{0,60}\b(stra(ß|ss)e|str\.|allee|platz)\b/i;

export function deterministicChecks(turn, out, priorReplies) {
  const reply = String(out?.reply || "");
  const card = out?.coachCard || {};
  const checks = {};
  const prevQ = priorReplies.flatMap(questions);
  checks.noRepeatedQuestion = !questions(reply).some((q) => prevQ.some((p) => similar(q, p) >= 0.8))
    && !(turn.mustNotAsk && questions(reply).some((q) => new RegExp(turn.mustNotAsk, "i").test(q)));
  const summary = String(card.summary || "");
  const replyQuestions = questions(reply);
  const summaryQuestions = questions(summary);
  const isConditionQuestion = (question) => /\b(?:what|which)\b.+\bshould i use\b/.test(question);
  const replyConditionQuestions = replyQuestions.filter(isConditionQuestion);
  const summaryConditionQuestions = summaryQuestions.filter(isConditionQuestion);
  // P10.8: the card and the reply must ask the same condition. Comparing the
  // last question in each (normalized text and condition key) catches the
  // "card asks pets, reply asks size" split on the turn it happens.
  checks.summaryQuestionMatchesReply = replyConditionQuestions.length === 0
    || (
      summaryConditionQuestions.length > 0
      && replyConditionQuestions[replyConditionQuestions.length - 1]
        === summaryConditionQuestions[summaryConditionQuestions.length - 1]
      && conditionKey(replyConditionQuestions[replyConditionQuestions.length - 1])
        === conditionKey(summaryConditionQuestions[summaryConditionQuestions.length - 1])
    );
  if (turn.expectsStepCoaching) {
    // P10.8: "What should I do on this step?" must say what the step is for
    // and end on the next action, never just name a fact from the lesson.
    checks.stepCoaching = reply.trim().length >= 40
      && /\?$/.test(reply.trim())
      && (!turn.mustMatch || new RegExp(turn.mustMatch, "i").test(reply));
  }
  // P10.6: the step-status scaffold ("Current step is … (STUDY) … Current
  // block: …") is internal vocabulary and must never reach a person.
  checks.noStatusScaffold = !/Current step is|Current block:/.test(reply)
    && !/Current step is|Current block:/.test(summary);
  if (out?.path !== "agent") {
    checks.summaryShort = summary.length > 0 && summary.length <= 220;
    checks.deepLink = /intentId=/.test(String(card.deepLink || ""));
    // P8.1: the card summary is coaching, never the "<label> is the open step." status line.
    checks.summaryNotStatusLine = summary.length > 0 && !/\bis the open step\.?\s*$/i.test(summary);
    // P8.4: the replies are derived from the lesson, never only the generic trio.
    const srAll = (card.suggestedReplies || []).map((r) => String(r).toLowerCase().trim());
    checks.repliesNotGeneric = srAll.length > 0 && !srAll.every((r) => GENERIC.has(r));
  }
  if (turn.expectsCondition && questions(reply).length) {
    const sr = (card.suggestedReplies || []).map((r) => String(r));
    checks.exampleReplies = sr.filter((r) => !GENERIC.has(r.toLowerCase().trim()) && !r.trim().endsWith("?")).length >= 2;
  }
  checks.noInventedListings = !LISTING.test(reply);
  return checks;
}

async function judge(turn, reply, baselineReply) {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) return { score: null, note: "no DEEPSEEK_API_KEY" };
  const prompt = `You grade one reply of a goal coach (Intentbios). The user said: ${JSON.stringify(turn.message)} (turn "${turn.id}").
Coach reply: ${JSON.stringify(reply).slice(0, 3000)}
${baselineReply ? `Baseline reply for the same turn: ${JSON.stringify(baselineReply).slice(0, 3000)}` : "No baseline yet."}
Is the reply correct (no invented facts/listings, sensible next step) and helpful (concrete, short, moves the user forward, no repeated questions)?
Answer JSON only: {"score":1-5,"correct":true|false,"helpful":true|false,"vsBaseline":"better|same|worse|n/a","note":"<=20 words"}`;
  const t0 = Date.now();
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: JUDGE_MODEL, thinking: { type: "disabled" }, response_format: { type: "json_object" }, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return { score: null, note: `judge HTTP ${r.status}` };
  const j = await r.json();
  let v = {};
  try { v = JSON.parse(j.choices?.[0]?.message?.content || "{}"); } catch { v = { note: "unparseable" }; }
  return { ...v, judgeMs: Date.now() - t0, judgeTokens: j.usage ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens } : null };
}

// The proxy answers either with Intentbios' coach card ({reply, coachCard}) or, when it hands the turn
// to the OpenClaw coach agent, with a chat.completion. Normalize both.
function normalize(o) {
  if (o?.choices) return { reply: o.choices[0]?.message?.content || "", usage: o.usage || null, path: "agent" };
  return { ...o, path: o?.handled ? "intentbios" : "unknown" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run at most `limit` jobs at once, preserving result order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function createFreshIntent(api, headers, rawInput) {
  const c = await fetch(`${api}/api/intents`, {
    method: "POST", headers, body: JSON.stringify({ rawInput }),
    signal: AbortSignal.timeout(180_000),
  });
  const cj = await c.json().catch(() => ({}));
  return { status: c.status, intentId: cj.intentId || null };
}

/**
 * P10.8: a case is only measured once its own fresh intent is a skill-graph
 * journey whose open step has a lesson. A template step or a half-written
 * graph is not the product this case is about.
 */
async function coachable(api, headers, intentId) {
  const [intentRes, graphRes] = await Promise.all([
    fetch(`${api}/api/intents/${encodeURIComponent(intentId)}`, { headers, signal: AbortSignal.timeout(60_000) }),
    fetch(`${api}/api/intents/${encodeURIComponent(intentId)}/journey-graphs`, { headers, signal: AbortSignal.timeout(180_000) }),
  ]);
  const intent = await intentRes.json().catch(() => ({}));
  const graphs = await graphRes.json().catch(() => ({}));
  const nodes = intent.graph?.nodes || [];
  const open = nodes.find((node) => node.status === "ready" || node.status === "in_progress");
  const skill = (graphs.bundle?.goalGraph?.nodes || []).some((node) => node.metadata?.journeySource === "skill_graph");
  return {
    ready: Boolean(skill && open && (open.lessonStatus === "ready" || open.learningMaterial)),
    skill,
    openNode: open?.id || null,
    lessonStatus: open?.lessonStatus || null,
  };
}

async function waitCoachable(api, headers, intentId, timeoutMs = 300_000) {
  const started = Date.now();
  let last = { ready: false };
  while (Date.now() - started < timeoutMs) {
    last = await coachable(api, headers, intentId).catch((err) => ({ ready: false, note: String(err?.message || err) }));
    if (last.ready) return { ...last, waitedMs: Date.now() - started };
    await sleep(5_000);
  }
  return { ...last, ready: false, waitedMs: Date.now() - started };
}

export async function runGolden({ baseline = readBaseline() } = {}) {
  const api = String(process.env.INTENTBIOS_API_URL || "").trim().replace(/\/+$/, "");
  if (!api) throw new Error("INTENTBIOS_API_URL unset");
  const headers = { "content-type": "application/json", "x-user-id": GOLDEN.userId };
  // P10.8: every case gets its own intent and its own history. No case can
  // inherit another case's splits, asked questions or answered conditions.
  const fixtures = await mapLimit(GOLDEN.turns, 3, async (turn) => {
    const rawInput = turn.createInput || turn.message;
    const created = await createFreshIntent(api, headers, rawInput)
      .catch((err) => ({ status: 0, intentId: null, note: String(err?.message || err) }));
    return { turn, rawInput, ...created };
  });
  const readiness = await mapLimit(fixtures, 3, async (fixture) => (
    fixture.intentId ? waitCoachable(api, headers, fixture.intentId) : { ready: false }
  ));
  const results = [];
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    const ready = readiness[index] || { ready: false };
    const turn = fixture.turn;
    const t0 = Date.now();
    let status = 0, out = {};
    const setupReplies = [];
    try {
      // P10.8: a case that is about a later turn carries its own setup turns,
      // on its own fresh intent. The scored turn is then the turn it names,
      // not always the first turn of a new journey.
      for (const setupMessage of turn.setup || []) {
        const setupResponse = await fetch(`${api}/api/openclaw/agents/intentbios-coach/invoke`, {
          method: "POST", headers: fixture.headers,
          body: JSON.stringify({ intentId: fixture.intentId, message: setupMessage }),
          signal: AbortSignal.timeout(180_000),
        });
        const setupJson = await setupResponse.json().catch(() => ({}));
        setupReplies.push(String((normalize(setupJson.output || {})).reply || ""));
      }
      const r = await fetch(`${api}/api/openclaw/agents/intentbios-coach/invoke`, {
        method: "POST", headers,
        body: JSON.stringify({ intentId: fixture.intentId, message: turn.message }),
        signal: AbortSignal.timeout(180_000),
      });
      status = r.status;
      const j = await r.json().catch(() => ({}));
      out = normalize(j.output || {});
    } catch (err) { out = { error: String(err.message || err) }; }
    const latencyMs = Date.now() - t0;
    const checks = status === 200 ? deterministicChecks(turn, out, setupReplies) : { http200: false };
    const base = baseline?.turns?.find((t) => t.id === turn.id);
    const j = status === 200 ? await judge(turn, out.reply, base?.reply).catch((e) => ({ score: null, note: e.message })) : { score: null };
    const detOk = Object.values(checks).every(Boolean);
    const judgeOk = j.score == null ? true : j.score >= 3 && (base?.judge?.score == null || j.score >= base.judge.score - 1);
    results.push({
      id: turn.id, status, latencyMs, intentId: out.intentId || fixture.intentId,
      freshIntent: fixture.intentId, coachedOnFreshIntent: Boolean(ready.ready),
      readyAfterMs: ready.waitedMs ?? null, openNode: ready.openNode || null,
      setupReplies: setupReplies.map((reply) => reply.slice(0, 400)),
      reply: String(out.reply || out.error || "").slice(0, 2000),
      summary: out.coachCard?.summary || null, deepLink: out.coachCard?.deepLink || null, suggestedReplies: out.coachCard?.suggestedReplies || [],
      path: out.path || null, coachTokens: out.usage || null, checks, judge: j, pass: status === 200 && detOk && judgeOk,
    });
  }
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const scores = results.map((r) => r.judge?.score).filter((s) => typeof s === "number");
  const interpretation = await runInterpretationCases();
  const payloadProbe = await runPayloadLeakProbe();
  return {
    at: new Date().toISOString(), userId: GOLDEN.userId, turns: results,
    passRate: results.filter((r) => r.pass).length / results.length,
    meanJudge: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    p50: q(0.5), p95: q(0.95), interpretation, payloadProbe,
  };
}

// P8.3: the raw lesson and the step contract must never reach the client. Create a guest find intent
// and post one normal message, then scan the raw JSON the journey route returns.
async function runPayloadLeakProbe() {
  const api = String(process.env.INTENTBIOS_API_URL || "").trim().replace(/\/+$/, "");
  if (!api) return { ran: false, note: "INTENTBIOS_API_URL unset" };
  const userId = `guest_p8_probe_${Date.now().toString(36)}`;
  const headers = { "content-type": "application/json", "x-user-id": userId };
  try {
    const c = await fetch(`${api}/api/intents`, {
      method: "POST", headers,
      body: JSON.stringify({ rawInput: "Find a systems engineer job in Berlin" }),
      signal: AbortSignal.timeout(180_000),
    });
    const cj = await c.json().catch(() => ({}));
    if (!cj.intentId) return { ran: false, note: "no intentId from create" };
    const m = await fetch(`${api}/api/intents/${encodeURIComponent(cj.intentId)}/journey/message`, {
      method: "POST", headers,
      body: JSON.stringify({ message: "I am ready to start looking for a job.", userId }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await m.text();
    let body = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    const card = body?.coachCard || {};
    const summary = String(card.summary || "");
    const replies = Array.isArray(card.suggestedReplies) ? card.suggestedReplies.map(String) : [];
    const hasLessonBody = /"lessonBody"/.test(raw);
    const hasContract = /intentbios-contract/.test(raw);
    const summaryIsStatusLine = /\bis the open step\b/i.test(summary);
    return {
      ran: true, status: m.status, bytes: raw.length, hasLessonBody, hasContract,
      summary, summaryIsStatusLine, replies,
      pass: m.status === 200 && !hasLessonBody && !hasContract && !summaryIsStatusLine,
    };
  } catch (err) {
    return { ran: false, note: String(err?.message || err) };
  }
}

// P5.7 — the interpretation layer is SCORED, never asserted. Acquisition is unit-tested against fixtures;
// the model's structured view is graded here: every fact must cite a page the pipeline held, and the view
// must carry the expected entities without inventing any. A regression is a drop in passRate.
export function scoreStructuredView({ review, citations = [], expect = [], mustNotInclude = [], minScore = 0.8 }) {
  const rows = Array.isArray(review?.rows) ? review.rows : [];
  if (!rows.length) {
    return { present: false, pass: false, score: 0, cited: 0, uncited: 0, matched: [], missing: [...expect], invented: [], reasons: ["no view was produced"] };
  }
  const allowed = new Set(citations.map(String));
  const uncited = rows.filter((row) => !allowed.has(String(row.link || ""))).length;
  const cited = rows.length - uncited;
  const hay = rows.flatMap((row) => Object.values(row.cells || {})).join(" \u0000 ").toLowerCase();
  const has = (needle) => hay.includes(String(needle || "").trim().toLowerCase());
  const matched = expect.filter(has);
  const missing = expect.filter((needle) => !has(needle));
  const invented = mustNotInclude.filter(has);
  const reasons = [];
  if (uncited) reasons.push(`${uncited} row(s) cite a page the pipeline did not hold`);
  if (missing.length) reasons.push(`missing expected entities: ${missing.join(", ")}`);
  if (invented.length) reasons.push(`invented entities: ${invented.join(", ")}`);
  const score = expect.length ? matched.length / expect.length : 1;
  const pass = uncited === 0 && invented.length === 0 && missing.length === 0 && score >= minScore;
  return { present: true, pass, score, cited, uncited, matched, missing, invented, reasons };
}

/** Replay the interpretation cases against production and grade the rows the find step produced. */
export async function runInterpretationCases() {
  const cases = Array.isArray(GOLDEN.interpretation) ? GOLDEN.interpretation : [];
  const api = String(process.env.INTENTBIOS_API_URL || "").trim().replace(/\/+$/, "");
  if (!api || !cases.length) return { at: new Date().toISOString(), passRate: null, cases: [] };
  const headers = { "content-type": "application/json", "x-user-id": GOLDEN.userId };
  const results = [];
  for (const c of cases) {
    let intentId = null, status = 0, reply = "", review = null, citations = [];
    try {
      const created = await fetch(`${api}/api/intents`, {
        method: "POST", headers, body: JSON.stringify({ rawInput: c.rawInput }), signal: AbortSignal.timeout(180_000),
      });
      const cj = await created.json().catch(() => ({}));
      intentId = cj.intentId || null;
      const r = await fetch(`${api}/api/intents/${intentId}/journey/message`, {
        method: "POST", headers, body: JSON.stringify({ message: c.message, userId: GOLDEN.userId }), signal: AbortSignal.timeout(180_000),
      });
      status = r.status;
      const j = await r.json().catch(() => ({}));
      review = j.review || null;
      reply = String(j.reply || "");
      citations = (review?.rows || []).map((row) => String(row.link || "")).filter(Boolean);
    } catch (err) { reply = String(err.message || err); }
    const score = scoreStructuredView({ review, citations, expect: c.expect, mustNotInclude: c.mustNotInclude, minScore: c.minScore });
    results.push({ id: c.id, status, intentId, reply: reply.slice(0, 600), citations, ...score });
  }
  return { at: new Date().toISOString(), passRate: results.filter((r) => r.pass).length / results.length, cases: results };
}

export function readBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch { return null; }
}

export function saveRun(run, { asBaseline = false } = {}) {
  fs.mkdirSync(path.join(EVAL_DIR, "runs"), { recursive: true });
  const file = path.join(EVAL_DIR, "runs", `coach-${run.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  if (asBaseline) fs.writeFileSync(BASELINE, JSON.stringify(run, null, 2));
  return file;
}

export function table(run) {
  const rows = run.turns.map((t) => `${t.pass ? "PASS" : "FAIL"} ${t.id.padEnd(14)} ${String(t.latencyMs).padStart(6)}ms judge=${t.judge?.score ?? "-"} ${Object.entries(t.checks).filter(([, v]) => !v).map(([k]) => `!${k}`).join(" ")}`);
  const interp = run.interpretation?.cases?.length
    ? ["", `interpretation pass ${run.interpretation.passRate == null ? "-" : `${(run.interpretation.passRate * 100).toFixed(0)}%`}`, ...run.interpretation.cases.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.id.padEnd(14)} score=${Number(c.score).toFixed(2)} uncited=${c.uncited}${c.reasons.length ? ` (${c.reasons.join("; ")})` : ""}`)]
    : [];
  return [`pass ${(run.passRate * 100).toFixed(0)}% meanJudge=${run.meanJudge?.toFixed(2) ?? "-"} p50=${run.p50}ms p95=${run.p95}ms`, ...rows, ...interp].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const asBaseline = process.argv.includes("--baseline");
  const run = await runGolden({ baseline: asBaseline ? null : readBaseline() });
  const file = saveRun(run, { asBaseline });
  console.log(`[evals] ${asBaseline ? "baseline" : "run"} saved ${file}\n${table(run)}`);
}
