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
  if (out?.path !== "agent") {
    checks.summaryShort = summary.length > 0 && summary.length <= 220;
    checks.deepLink = /intentId=/.test(String(card.deepLink || ""));
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

export async function runGolden({ baseline = readBaseline() } = {}) {
  const api = String(process.env.INTENTBIOS_API_URL || "").trim().replace(/\/+$/, "");
  if (!api) throw new Error("INTENTBIOS_API_URL unset");
  const intents = {}, prior = {}, results = [];
  for (const turn of GOLDEN.turns) {
    const headers = { "content-type": "application/json", "x-user-id": GOLDEN.userId };
    const t0 = Date.now();
    let status = 0, out = {};
    try {
      if (turn.create) {
        // Intake: create the intent, then the coach's first turn on it (same as the app's create flow).
        const c = await fetch(`${api}/api/intents`, { method: "POST", headers, body: JSON.stringify({ rawInput: turn.message }), signal: AbortSignal.timeout(180_000) });
        const cj = await c.json().catch(() => ({}));
        if (cj.intentId) intents[turn.seq] = cj.intentId;
      }
      const r = await fetch(`${api}/api/openclaw/agents/intentbios-coach/invoke`, {
        method: "POST", headers,
        body: JSON.stringify({ intentId: intents[turn.seq], message: turn.message }),
        signal: AbortSignal.timeout(180_000),
      });
      status = r.status;
      const j = await r.json().catch(() => ({}));
      out = normalize(j.output || {});
    } catch (err) { out = { error: String(err.message || err) }; }
    const latencyMs = Date.now() - t0;
    if (out.intentId) intents[turn.seq] = out.intentId;
    const checks = status === 200 ? deterministicChecks(turn, out, prior[turn.seq] || []) : { http200: false };
    (prior[turn.seq] ||= []).push(String(out.reply || ""));
    const base = baseline?.turns?.find((t) => t.id === turn.id);
    const j = status === 200 ? await judge(turn, out.reply, base?.reply).catch((e) => ({ score: null, note: e.message })) : { score: null };
    const detOk = Object.values(checks).every(Boolean);
    const judgeOk = j.score == null ? true : j.score >= 3 && (base?.judge?.score == null || j.score >= base.judge.score - 1);
    results.push({
      id: turn.id, status, latencyMs, intentId: out.intentId || null, reply: String(out.reply || out.error || "").slice(0, 2000),
      summary: out.coachCard?.summary || null, deepLink: out.coachCard?.deepLink || null, suggestedReplies: out.coachCard?.suggestedReplies || [],
      path: out.path || null, coachTokens: out.usage || null, checks, judge: j, pass: status === 200 && detOk && judgeOk,
    });
  }
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const scores = results.map((r) => r.judge?.score).filter((s) => typeof s === "number");
  return {
    at: new Date().toISOString(), userId: GOLDEN.userId, turns: results,
    passRate: results.filter((r) => r.pass).length / results.length,
    meanJudge: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    p50: q(0.5), p95: q(0.95),
  };
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
  return [`pass ${(run.passRate * 100).toFixed(0)}% meanJudge=${run.meanJudge?.toFixed(2) ?? "-"} p50=${run.p50}ms p95=${run.p95}ms`, ...rows].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const asBaseline = process.argv.includes("--baseline");
  const run = await runGolden({ baseline: asBaseline ? null : readBaseline() });
  const file = saveRun(run, { asBaseline });
  console.log(`[evals] ${asBaseline ? "baseline" : "run"} saved ${file}\n${table(run)}`);
}
