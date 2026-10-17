#!/usr/bin/env node
// Hard gate for the "intentbios autonomous plan" automation (approved by Gustavo 2026-10-17).
// Called by the job's trigger script before every wake; the scheduler runs the agent turn only
// when this prints {"fire":true}. Rules:
//   - window: 13:00-19:00 Europe/Berlin (DeepSeek off-peak); outside it the job never fires
//   - budget: at most PLAN_MAX_PER_DAY (3) new plan items per Berlin day, counted in
//     /data/workspace/evals/plan-budget.json
//   - one worker at a time: while an item is `in-flight`, the wake may only settle it (may_spawn=false)
// Usage: node plan-gate.mjs check | status
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.EVAL_DIR || "/data/workspace/evals";
const BUDGET = path.join(DIR, "plan-budget.json");
const PLAN = process.env.PLAN_FILE || "/data/workspace/notes/intentbios-autonomous-plan.md";
export const MAX_PER_DAY = 3;
export const WINDOW = { start: 13, end: 19 }; // [start, end) Berlin hours

export function berlinNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function decide({ now = new Date(), planText = "", budget = {} } = {}) {
  const { date, hour } = berlinNow(now);
  const b = budget.date === date ? { ...budget } : { date, spawned: 0, log: [] };
  const inFlight = /\|\s*in-flight\s*\|/i.test(planText);
  const pending = /\|\s*pending\s*\|/i.test(planText);
  let r;
  if (hour < WINDOW.start || hour >= WINDOW.end) r = { fire: false, reason: `outside window ${WINDOW.start}:00-${WINDOW.end}:00 Berlin` };
  else if (inFlight) r = { fire: true, maySpawn: false, reason: "worker in flight: settle only" };
  else if (b.spawned >= MAX_PER_DAY) r = { fire: false, reason: `daily cap reached (${b.spawned}/${MAX_PER_DAY})` };
  else if (!pending) r = { fire: false, reason: "no pending items" };
  else { b.spawned += 1; r = { fire: true, maySpawn: true, reason: `spawn slot ${b.spawned}/${MAX_PER_DAY}` }; }
  b.log = [...(b.log || []), { at: now.toISOString(), fire: r.fire, reason: r.reason }].slice(-50);
  r.message = r.fire
    ? `[plan-gate] may_spawn=${r.maySpawn} (${r.reason}; ${b.spawned}/${MAX_PER_DAY} items today, window ${WINDOW.start}-${WINDOW.end} Berlin). ${r.maySpawn ? "You may start exactly ONE pending item as a subagent." : "Do NOT start a new item this wake; only check/settle the in-flight worker and update the plan table."}`
    : undefined;
  return { result: r, budget: b };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const cmd = process.argv[2] || "status";
  let budget = {};
  try { budget = JSON.parse(fs.readFileSync(BUDGET, "utf8")); } catch { budget = {}; }
  let planText = "";
  try { planText = fs.readFileSync(PLAN, "utf8"); } catch { planText = ""; }
  if (cmd === "check") {
    const { result, budget: nb } = decide({ planText, budget });
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(BUDGET, JSON.stringify(nb, null, 2));
    console.log(JSON.stringify({ fire: result.fire, message: result.message, reason: result.reason }));
  } else {
    console.log(JSON.stringify({ budget, window: WINDOW, max: MAX_PER_DAY, now: berlinNow() }));
  }
}
