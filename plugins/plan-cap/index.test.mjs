import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("plugin gates sessions_spawn from plan sessions only and forces flash/off", async () => {
  process.env.EVAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plancap-"));
  const { default: plugin } = await import(`./index.js?${Date.now()}`);
  const hooks = {};
  plugin.register({ on: (name, fn) => { hooks[name] = fn; } });
  const call = (sessionKey, params = { task: "x", model: "deepseek/deepseek-v4-pro", thinking: "high" }) =>
    hooks.before_tool_call({ toolName: "sessions_spawn", params }, { agentId: "main", sessionKey });
  assert.equal(call("agent:main:discord:channel:1"), undefined);
  assert.equal(hooks.before_tool_call({ toolName: "exec", params: {} }, { agentId: "main", sessionKey: "agent:main:dashboard:a" }), undefined);
  const r = call("agent:main:dashboard:a");
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  if (hour >= 13 && hour < 19) {
    assert.deepEqual([r.params.model, r.params.thinking], ["deepseek/deepseek-v4-flash", "off"]);
    hooks.subagent_spawned({ childSessionKey: "agent:main:subagent:c1" }, { requesterSessionKey: "agent:main:dashboard:a" });
    assert.equal(call("agent:main:dashboard:a").block, true); // one at a time
    hooks.subagent_ended({ targetSessionKey: "agent:main:subagent:c1", outcome: "ok" });
    assert.ok(call("agent:main:dashboard:a").params);
  } else {
    assert.equal(r.block, true);
    assert.match(r.blockReason, /outside the off-peak window/);
  }
});
