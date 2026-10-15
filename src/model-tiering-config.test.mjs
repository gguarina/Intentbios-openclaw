import test from "node:test";
import assert from "node:assert/strict";
import { mergeModelTiering, FLASH, PRO, describeTiers } from "./model-tiering-config.mjs";

const base = () => ({
  agents: {
    defaults: { model: { primary: FLASH, fallbacks: [] }, thinkingDefault: "high", heartbeat: { every: "30m" } },
    entries: {
      main: { workspace: "/data/workspace", subagents: { allowAgents: ["intentbios-coach"] } },
      "intentbios-coach": { model: FLASH },
      "intentbios-sophia": { model: "x/y", thinkingDefault: "high" },
      "ash-editor": { model: PRO }, "ash-coldreader": { model: PRO }, "ash-continuity": { model: FLASH },
    },
  },
});

test("tiers agents, defaults and planner", () => {
  const c = base();
  const before = JSON.stringify(c);
  const m = mergeModelTiering(c);
  assert.equal(JSON.stringify(c), before, "input not mutated");
  const e = m.agents.entries, d = m.agents.defaults;
  assert.deepEqual([e.main.model, e.main.thinkingDefault], [FLASH, "low"]);
  assert.deepEqual([e.planner.model, e.planner.thinkingDefault, e.planner.workspace], [PRO, "medium", "/data/workspace"]);
  assert.deepEqual(e.main.subagents.allowAgents, ["intentbios-coach", "planner"]);
  assert.equal(e["intentbios-coach"].thinkingDefault, "off");
  assert.equal(e["ash-editor"].model, PRO);
  assert.deepEqual([e["ash-coldreader"].model, e["ash-continuity"].thinkingDefault], [FLASH, "off"]);
  assert.equal(e["intentbios-sophia"], c.agents.entries["intentbios-sophia"]);
  assert.deepEqual(d.model, { primary: FLASH, fallbacks: [] });
  assert.equal(d.thinkingDefault, "off");
  assert.deepEqual(d.subagents, { model: FLASH, thinking: "off" });
  assert.equal(d.heartbeat.model, FLASH);
  assert.deepEqual([d.compaction.model, d.compaction.thinkingLevel, d.compaction.memoryFlush.model], [FLASH, "off", FLASH]);
  assert.match(describeTiers(m), /planner=deepseek\/deepseek-v4-pro\/medium/);
});

test("idempotent and skips absent agents", () => {
  const m1 = mergeModelTiering(base());
  assert.deepEqual(mergeModelTiering(m1), m1);
  const m = mergeModelTiering({ agents: { entries: { main: {} } } });
  assert.equal(m.agents.entries["ash-editor"], undefined);
});
