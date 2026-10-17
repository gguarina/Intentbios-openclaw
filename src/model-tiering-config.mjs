// Model tiering (cost control). Cheap by default, pro only where it pays off:
// - defaults (cron runs, subagents, heartbeat, compaction, memory flush): flash, thinking off
// - main (coding in #dev): flash, thinking low; escalates to pro after two stuck attempts (see knowledge)
// - planner: pro, thinking medium; main delegates the planning phase of #dev tasks to it
// - intentbios-coach: flash, thinking off
// - ash-editor: pro (unchanged); ash-coldreader / ash-continuity: flash, thinking off
// Runs last in the boot merge chain so it wins over earlier modules. intentbios-sophia is never touched.
export const FLASH = "deepseek/deepseek-v4-flash"; // legacy id, served by DeepSeek V4.1 Flash at Flash prices
export const PRO = "deepseek/deepseek-v4-pro";
export const PLANNER_AGENT_ID = "planner";

export const AGENT_TIERS = {
  main: { model: FLASH, thinkingDefault: "low" },
  [PLANNER_AGENT_ID]: { model: PRO, thinkingDefault: "medium" },
  "intentbios-coach": { model: FLASH, thinkingDefault: "off" },
  "ash-editor": { model: PRO, thinkingDefault: "high" }, // unchanged from before tiering (was the inherited default)
  "ash-coldreader": { model: FLASH, thinkingDefault: "off" },
  "ash-continuity": { model: FLASH, thinkingDefault: "off" },
};

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const union = (a, b) => Array.from(new Set([...(Array.isArray(a) ? a : []), ...b]));

export function mergeModelTiering(config, { mainWorkspace } = {}) {
  if (!isObj(config)) throw new Error("mergeModelTiering requires a config object");
  const agents = isObj(config.agents) ? { ...config.agents } : {};
  const defaults = isObj(agents.defaults) ? { ...agents.defaults } : {};
  const curModel = defaults.model;
  defaults.model = isObj(curModel) ? { ...curModel, primary: FLASH } : { primary: FLASH };
  defaults.thinkingDefault = "off";
  defaults.subagents = { ...(isObj(defaults.subagents) ? defaults.subagents : {}), model: FLASH, thinking: "off" };
  if (isObj(defaults.heartbeat)) defaults.heartbeat = { ...defaults.heartbeat, model: FLASH };
  const comp = isObj(defaults.compaction) ? { ...defaults.compaction } : {};
  comp.model = FLASH;
  comp.thinkingLevel = "off";
  // Compact early so prompts stay well under ~180k tokens (Oct 17 analysis saw a 287k prompt).
  comp.maxActiveTranscriptBytes = "1.5mb";
  comp.keepRecentTokens = 20000;
  comp.memoryFlush = { ...(isObj(comp.memoryFlush) ? comp.memoryFlush : {}), model: FLASH };
  defaults.compaction = comp;
  agents.defaults = defaults;

  const entries = isObj(agents.entries) ? { ...agents.entries } : {};
  const sophiaBefore = entries["intentbios-sophia"];
  for (const [id, tier] of Object.entries(AGENT_TIERS)) {
    if (id === PLANNER_AGENT_ID) continue;
    if (!isObj(entries[id])) continue; // only tier agents that exist
    const cur = { ...entries[id], ...tier };
    if (isObj(cur.heartbeat)) cur.heartbeat = { ...cur.heartbeat, model: FLASH };
    entries[id] = cur;
  }
  if (isObj(entries.main)) {
    const sub = isObj(entries.main.subagents) ? entries.main.subagents : {};
    entries.main = {
      ...entries.main,
      // One active child per main session: plan workers run one at a time on flash/off.
      subagents: { ...sub, allowAgents: union(sub.allowAgents, [PLANNER_AGENT_ID]), model: FLASH, thinking: "off", maxChildrenPerAgent: 1 },
    };
    // Planner: read-mostly, shares main's workspace so it sees the clones. Never pushes or merges.
    const cur = isObj(entries[PLANNER_AGENT_ID]) ? entries[PLANNER_AGENT_ID] : {};
    entries[PLANNER_AGENT_ID] = {
      ...cur,
      name: "Planner",
      workspace: mainWorkspace || entries.main.workspace || cur.workspace,
      ...AGENT_TIERS[PLANNER_AGENT_ID],
      tools: { profile: "coding", deny: ["write", "edit", "apply_patch", "message", "cron", "sessions_spawn"] },
      subagents: { allowAgents: [] },
    };
    if (!entries[PLANNER_AGENT_ID].workspace) delete entries[PLANNER_AGENT_ID].workspace;
  }
  if (entries["intentbios-sophia"] !== sophiaBefore) throw new Error("refusing to modify intentbios-sophia");
  agents.entries = entries;
  return { ...config, agents };
}

/** One log line per agent: id -> model / thinking, as resolved from config. */
export function describeTiers(config) {
  const d = config?.agents?.defaults || {};
  const dm = isObj(d.model) ? d.model.primary : d.model;
  const pick = (m) => (isObj(m) ? m.primary : m) || dm;
  const rows = Object.entries(config?.agents?.entries || {}).map(
    ([id, e]) => `${id}=${pick(e?.model)}/${e?.thinkingDefault || d.thinkingDefault || "default"}`,
  );
  rows.push(`subagents=${d.subagents?.model}/${d.subagents?.thinking}`);
  rows.push(`heartbeat=${d.heartbeat?.model || dm}`);
  rows.push(`compaction=${d.compaction?.model}/${d.compaction?.thinkingLevel} maxActiveTranscriptBytes=${d.compaction?.maxActiveTranscriptBytes} keepRecentTokens=${d.compaction?.keepRecentTokens} memoryFlush=${d.compaction?.memoryFlush?.model}`);
  const ms = config?.agents?.entries?.main?.subagents;
  if (ms) rows.push(`main.subagents=${ms.model}/${ms.thinking} maxChildrenPerAgent=${ms.maxChildrenPerAgent}`);
  return rows.join(" ");
}
