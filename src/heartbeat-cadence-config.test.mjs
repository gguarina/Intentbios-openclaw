import test from "node:test";
import assert from "node:assert/strict";
import { mergeHeartbeatCadence, describeHeartbeatCadence, describeEverySchedule } from "./heartbeat-cadence-config.mjs";

test("sets 24h on defaults and on agents that have a heartbeat, nowhere else", () => {
  const c = {
    agents: {
      defaults: { heartbeat: { every: "1h", model: "m", target: "discord" } },
      entries: { main: { heartbeat: { every: "1h" } }, "ash-editor": { model: "p" } },
      list: [{ id: "x", heartbeat: {} }, { id: "y" }],
    },
  };
  const before = JSON.stringify(c);
  const m = mergeHeartbeatCadence(c);
  assert.equal(JSON.stringify(c), before, "input not mutated");
  assert.deepEqual(m.agents.defaults.heartbeat, { every: "24h", model: "m", target: "discord" });
  assert.equal(m.agents.entries.main.heartbeat.every, "24h");
  assert.equal(m.agents.entries["ash-editor"].heartbeat, undefined);
  assert.equal(m.agents.list[0].heartbeat.every, "24h");
  assert.equal(m.agents.list[1].heartbeat, undefined);
  assert.equal(describeHeartbeatCadence(m), "defaults=24h main=24h x=24h");
  assert.deepEqual(mergeHeartbeatCadence(m), m, "idempotent");
});

test("does not create heartbeat blocks", () => {
  const c = { agents: { defaults: { model: "m" }, entries: { main: {} } } };
  assert.deepEqual(mergeHeartbeatCadence(c), c);
  assert.equal(describeHeartbeatCadence(c), "none");
  assert.deepEqual(mergeHeartbeatCadence({ gateway: {} }), { gateway: {} });
});

test("describes every-schedules", () => {
  assert.equal(describeEverySchedule({ kind: "every", everyMs: 3_600_000, anchorMs: 1 }), "every=1h");
  assert.match(describeEverySchedule({ kind: "every", everyMs: 86_400_000, anchorMs: 11 * 3_600_000 + 10 * 60_000 }),
    /^every=24h daily at 11:10:00 UTC \(13:10:00 Europe\/Berlin/);
  assert.match(describeEverySchedule({ kind: "cron", expr: "5 * * * *" }), /cron/);
});
