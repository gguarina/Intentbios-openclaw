import test from "node:test";
import assert from "node:assert/strict";
import { spawnDecision, wakeDecision, isPlanSession, MAX_PER_DAY, STALE_MS } from "../plugins/plan-cap/gate.mjs";
const at = (h, m = 5) => new Date(`2026-10-17T${String(h - 2).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`); // Berlin = UTC+2
const plan = (s) => `| P1 | x | ${s} | - |`;

test("spawn: blocked outside 13-19 Berlin", () => {
  for (const h of [3, 9, 11, 12, 19, 23]) assert.equal(spawnDecision({ now: at(h) }).allow, false);
  assert.equal(spawnDecision({ now: at(13) }).allow, true);
});
test("spawn: 3 per Berlin day, resets next day", () => {
  let budget = {};
  const out = [];
  for (let i = 0; i < 5; i++) { const d = spawnDecision({ now: at(14), budget }); budget = d.budget; out.push(d.allow); }
  assert.deepEqual(out, [true, true, true, false, false]);
  assert.equal(budget.spawned, MAX_PER_DAY);
  assert.equal(spawnDecision({ now: new Date("2026-10-18T12:00:00Z"), budget }).allow, true);
});
test("spawn: one worker at a time; stale workers expire", () => {
  const now = at(15);
  const active = { children: { "agent:main:subagent:a": new Date(now - 60_000).toISOString() } };
  assert.equal(spawnDecision({ now, active }).allow, false);
  const stale = { children: { "agent:main:subagent:a": new Date(now - STALE_MS - 1).toISOString() } };
  assert.equal(spawnDecision({ now, active: stale }).allow, true);
});
test("wake: never fires outside the window; settles in-flight without spawn", () => {
  assert.equal(wakeDecision({ now: at(10), planText: plan("pending") }).fire, false);
  const w = wakeDecision({ now: at(15), planText: plan("in-flight") + "\n" + plan("pending") });
  assert.deepEqual([w.fire, w.maySpawn], [true, false]);
  assert.equal(wakeDecision({ now: at(15), planText: plan("done") }).fire, false);
  assert.equal(wakeDecision({ now: at(15), budget: { date: "2026-10-17", spawned: 3 }, planText: plan("pending") }).fire, false);
  assert.equal(wakeDecision({ now: at(15), planText: null }).maySpawn, true);
});
test("plan sessions: main dashboard and the plan cron only", () => {
  assert.equal(isPlanSession("main", "agent:main:dashboard:abc", null), true);
  assert.equal(isPlanSession("main", "agent:main:cron:job1:run:x", "job1"), true);
  assert.equal(isPlanSession("main", "agent:main:cron:other", "job1"), false);
  assert.equal(isPlanSession("main", "agent:main:discord:channel:1", "job1"), false);
  assert.equal(isPlanSession("ash-editor", "agent:ash-editor:dashboard:x", null), false);
});
