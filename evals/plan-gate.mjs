#!/usr/bin/env node
// Cron trigger gate for the capped autonomous plan (approved by Gustavo 2026-10-17).
// The plan cron's trigger script runs `node plan-gate.mjs check`; the scheduler runs the agent turn
// only when this prints {"fire":true}. It never consumes budget: the plan-cap plugin counts each
// allowed sessions_spawn in /data/workspace/evals/plan-budget.json and blocks anything over the cap.
// Usage: node plan-gate.mjs check | status
import path from "node:path";
import {
  ACTIVE, BUDGET, MAX_PER_DAY, WINDOW, berlinNow, liveActive, planCronId, readJson, readPlanText, todayBudget, wakeDecision, wakeMessage,
} from "../plugins/plan-cap/gate.mjs";

export { MAX_PER_DAY, WINDOW, wakeDecision, wakeMessage };

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const cmd = process.argv[2] || "status";
  const budget = readJson(BUDGET);
  const active = readJson(ACTIVE);
  if (cmd === "check") {
    const r = wakeDecision({ budget, active, planText: readPlanText() });
    console.log(JSON.stringify({ fire: r.fire, message: wakeMessage(r), reason: r.reason }));
  } else {
    const plan = readPlanText();
    console.log(JSON.stringify({
      budget: todayBudget(budget), activeWorkers: Object.keys(liveActive(active)).length, window: WINDOW, max: MAX_PER_DAY,
      now: berlinNow(), planCronId: planCronId(), planFile: plan == null ? "missing" : { pending: (plan.match(/\|\s*pending\s*\|/gi) || []).length, inFlight: (plan.match(/\|\s*in-flight\s*\|/gi) || []).length },
    }));
  }
}
