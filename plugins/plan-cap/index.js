/**
 * OpenClaw plugin: plan-cap. Hard, code-level cap on the autonomous plan (Gustavo, 2026-10-17):
 * sessions_spawn from a plan session (agent:main:dashboard:* or the capped plan cron) is allowed only
 * 13:00-19:00 Berlin, at most 3 per Berlin day, one running worker at a time; allowed spawns are forced
 * onto flash with thinking off. Counter: /data/workspace/evals/plan-budget.json. Discord sessions are untouched.
 */
import {
  ACTIVE, BUDGET, FLASH, isPlanSession, liveActive, readJson, spawnDecision, writeJson, berlinNow,
} from "./gate.mjs";

const SPAWN_TOOLS = new Set(["sessions_spawn"]);
const log = (msg) => console.log(`[plan-cap] ${msg}`);

export default {
  id: "plan-cap",
  name: "Plan cap",
  description: "Caps the autonomous plan: off-peak window, 3 items per Berlin day, one flash/off worker at a time.",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    if (typeof api.on !== "function") return;
    api.on("before_tool_call", (event, ctx) => {
      if (!SPAWN_TOOLS.has(String(event?.toolName || ""))) return undefined;
      if (!isPlanSession(ctx?.agentId, ctx?.sessionKey)) return undefined;
      const now = new Date();
      const d = spawnDecision({ now, budget: readJson(BUDGET), active: readJson(ACTIVE) });
      const entry = { at: now.toISOString(), allow: d.allow, reason: d.reason, session: String(ctx?.sessionKey || "").slice(0, 80) };
      writeJson(BUDGET, { ...d.budget, log: [...(d.budget.log || []), entry].slice(-50) });
      log(`${d.allow ? "allow" : "block"} sessions_spawn session=${entry.session} ${d.reason} berlin=${JSON.stringify(berlinNow(now))}`);
      if (!d.allow) {
        return {
          block: true,
          blockReason: `plan-cap: ${d.reason}. The autonomous plan is capped (13:00-19:00 Berlin, 3 items/day, one worker at a time). Do not retry or work around this; update the plan table if needed and end the turn.`,
        };
      }
      const params = { ...(event.params || {}), model: FLASH };
      if (params.visible === true) delete params.thinking; else params.thinking = "off";
      return { params };
    }, { priority: 100 });

    api.on("subagent_spawned", (event, ctx) => {
      const requester = ctx?.requesterSessionKey || "";
      if (!isPlanSession("main", requester)) return;
      const key = event?.childSessionKey || ctx?.childSessionKey;
      if (!key) return;
      const a = readJson(ACTIVE);
      writeJson(ACTIVE, { children: { ...liveActive(a), [key]: new Date().toISOString() } });
      log(`worker started ${key} model=${event?.resolvedModel || "-"}`);
    });

    api.on("subagent_ended", (event) => {
      const key = event?.targetSessionKey;
      const a = readJson(ACTIVE);
      if (!key || !a.children || !(key in a.children)) return;
      const { [key]: _gone, ...rest } = a.children;
      writeJson(ACTIVE, { children: rest });
      log(`worker ended ${key} outcome=${event?.outcome || event?.reason || "-"}`);
    });
  },
};
