// Plan cap core (approved by Gustavo 2026-10-17): the autonomous plan may start at most
// MAX_PER_DAY items per Europe/Berlin day, only 13:00-19:00 Berlin (DeepSeek off-peak),
// one worker at a time, workers on flash with thinking off.
// Shared by the plan-cap plugin (hard gate on sessions_spawn) and evals/plan-gate.mjs (cron trigger).
import fs from "node:fs";
import path from "node:path";

export const DIR = process.env.EVAL_DIR || "/data/workspace/evals";
export const BUDGET = path.join(DIR, "plan-budget.json");
export const ACTIVE = path.join(DIR, "plan-active.json");
export const CRON_ID = path.join(DIR, "plan-cron-id.txt");
export const PLAN = process.env.PLAN_FILE || "/data/workspace/notes/intentbios-autonomous-plan.md";
export const MAX_PER_DAY = 3;
export const MAX_ACTIVE = 1;
export const WINDOW = { start: 13, end: 19 }; // [start, end) Berlin hours
export const STALE_MS = 3 * 60 * 60 * 1000; // a worker not reported ended after 3h is assumed gone
export const FLASH = "deepseek/deepseek-v4-flash";

export function berlinNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export const inWindow = (hour) => hour >= WINDOW.start && hour < WINDOW.end;

export function todayBudget(budget = {}, now = new Date()) {
  const { date } = berlinNow(now);
  return budget.date === date ? { log: [], ...budget } : { date, spawned: 0, log: [] };
}

export function liveActive(active = {}, now = new Date()) {
  const out = {};
  for (const [k, at] of Object.entries(active.children || {})) if (now - new Date(at) < STALE_MS) out[k] = at;
  return out;
}

/** Hard gate for one sessions_spawn from a plan session. Pure. */
export function spawnDecision({ now = new Date(), budget = {}, active = {} } = {}) {
  const { hour } = berlinNow(now);
  const b = todayBudget(budget, now);
  const live = Object.keys(liveActive(active, now)).length;
  if (!inWindow(hour)) return { allow: false, budget: b, reason: `outside the off-peak window ${WINDOW.start}:00-${WINDOW.end}:00 Berlin` };
  if (live >= MAX_ACTIVE) return { allow: false, budget: b, reason: `a plan worker is still running (${live}/${MAX_ACTIVE})` };
  if (b.spawned >= MAX_PER_DAY) return { allow: false, budget: b, reason: `daily cap reached (${b.spawned}/${MAX_PER_DAY} items today)` };
  const nb = { ...b, spawned: b.spawned + 1 };
  return { allow: true, budget: nb, reason: `slot ${nb.spawned}/${MAX_PER_DAY}` };
}

/** Cron trigger decision: wake only in the window, and only when there is something to do. Never consumes budget. */
export function wakeDecision({ now = new Date(), budget = {}, active = {}, planText = null } = {}) {
  const { hour } = berlinNow(now);
  const b = todayBudget(budget, now);
  const live = Object.keys(liveActive(active, now)).length;
  if (!inWindow(hour)) return { fire: false, reason: `outside window ${WINDOW.start}:00-${WINDOW.end}:00 Berlin` };
  const inFlight = live > 0 || (planText != null && /\|\s*in-flight\s*\|/i.test(planText));
  if (inFlight) return { fire: true, maySpawn: false, reason: "worker in flight: settle only", spawned: b.spawned };
  if (b.spawned >= MAX_PER_DAY) return { fire: false, reason: `daily cap reached (${b.spawned}/${MAX_PER_DAY})` };
  if (planText != null && !/\|\s*pending\s*\|/i.test(planText)) return { fire: false, reason: "no pending items" };
  return { fire: true, maySpawn: true, reason: `slot available (${b.spawned}/${MAX_PER_DAY} used)`, spawned: b.spawned };
}

export function wakeMessage(r) {
  if (!r.fire) return undefined;
  return `[plan-gate] may_spawn=${r.maySpawn} (${r.reason}; ${r.spawned}/${MAX_PER_DAY} items today, window ${WINDOW.start}-${WINDOW.end} Berlin). ` +
    (r.maySpawn
      ? "You may start exactly ONE pending item with sessions_spawn (subagent, flash, thinking off)."
      : "Do NOT start a new item this wake; only check/settle the in-flight worker and update the plan table.");
}

export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
export function readPlanText() {
  try { return fs.readFileSync(PLAN, "utf8"); } catch { return null; }
}
export function planCronId() {
  try { return fs.readFileSync(CRON_ID, "utf8").trim() || null; } catch { return null; }
}

/** Sessions whose spawns count as plan work: main's dashboard sessions and the capped plan cron. */
export function isPlanSession(agentId, sessionKey, cronId = planCronId()) {
  const key = String(sessionKey || "");
  if (agentId && agentId !== "main") return false;
  if (!key.startsWith("agent:main:")) return false;
  if (key.startsWith("agent:main:dashboard:")) return true;
  return Boolean(cronId && key.includes(`cron:${cronId}`));
}
