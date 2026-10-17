import test from "node:test";
import assert from "node:assert/strict";
import { decide, MAX_PER_DAY } from "./plan-gate.mjs";
const at = (h) => new Date(`2026-10-17T${String(h - 2).padStart(2, "0")}:05:00Z`); // Berlin = UTC+2
const plan = (s) => `| P1 | x | ${s} | - |`;
test("outside window never fires", () => {
  for (const h of [3, 9, 11, 12, 19, 23]) assert.equal(decide({ now: at(h), planText: plan("pending") }).result.fire, false);
});
test("cap 3 per Berlin day, then stops", () => {
  let budget = {};
  const fires = [];
  for (let i = 0; i < 5; i++) { const d = decide({ now: at(14), planText: plan("pending"), budget }); budget = d.budget; fires.push(d.result.fire); }
  assert.deepEqual(fires, [true, true, true, false, false]);
  assert.equal(budget.spawned, MAX_PER_DAY);
  assert.equal(decide({ now: new Date("2026-10-18T12:00:00Z"), planText: plan("pending"), budget }).result.fire, true);
});
test("in-flight: fires to settle, no spawn, no budget use", () => {
  const d = decide({ now: at(15), planText: plan("in-flight") + "\n" + plan("pending") });
  assert.equal(d.result.fire, true);
  assert.match(d.result.message, /may_spawn=false/);
  assert.equal(d.budget.spawned, 0);
});
test("empty queue does not fire", () => assert.equal(decide({ now: at(15), planText: plan("done") }).result.fire, false));
