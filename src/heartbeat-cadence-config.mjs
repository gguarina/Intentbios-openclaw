// Heartbeat cadence (approved 2026-10-18): once every 24h instead of hourly.
// OpenClaw 2026.9.4 projects heartbeat config into a system-owned cron monitor per agent
// ("heartbeat-<agentId>", schedule kind "every", anchor = deterministic phase), and the gateway
// re-converges that row to config on start. So the cadence is changed in config, not by editing
// the cron row (a manual edit would be reverted). Only heartbeat blocks that already exist are
// touched: creating agents.defaults.heartbeat would enroll every agent in heartbeats.
export const HEARTBEAT_EVERY = "24h";

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function mergeHeartbeatCadence(config, every = HEARTBEAT_EVERY) {
  if (!isObj(config)) throw new Error("mergeHeartbeatCadence requires a config object");
  if (!isObj(config.agents)) return config;
  const agents = { ...config.agents };
  if (isObj(agents.defaults) && isObj(agents.defaults.heartbeat)) {
    agents.defaults = { ...agents.defaults, heartbeat: { ...agents.defaults.heartbeat, every } };
  }
  if (isObj(agents.entries)) {
    const entries = { ...agents.entries };
    for (const [id, e] of Object.entries(entries)) {
      if (isObj(e) && isObj(e.heartbeat)) entries[id] = { ...e, heartbeat: { ...e.heartbeat, every } };
    }
    agents.entries = entries;
  }
  if (Array.isArray(agents.list)) {
    agents.list = agents.list.map((e) => (isObj(e) && isObj(e.heartbeat) ? { ...e, heartbeat: { ...e.heartbeat, every } } : e));
  }
  return { ...config, agents };
}

/** "defaults=24h main=24h" for every heartbeat block present in config. */
export function describeHeartbeatCadence(config) {
  const a = config?.agents || {};
  const rows = [];
  if (isObj(a.defaults?.heartbeat)) rows.push(`defaults=${a.defaults.heartbeat.every ?? "unset"}`);
  for (const [id, e] of Object.entries(isObj(a.entries) ? a.entries : {})) {
    if (isObj(e?.heartbeat)) rows.push(`${id}=${e.heartbeat.every ?? "inherit"}`);
  }
  for (const e of Array.isArray(a.list) ? a.list : []) {
    if (isObj(e?.heartbeat)) rows.push(`${e.id}=${e.heartbeat.every ?? "inherit"}`);
  }
  return rows.length ? rows.join(" ") : "none";
}

/** Daily fire time for an "every 24h" monitor: anchorMs is the offset from the epoch. */
export function describeEverySchedule(schedule, timeZone = "Europe/Berlin") {
  if (!isObj(schedule)) return "schedule=?";
  if (schedule.kind !== "every") return `schedule=${JSON.stringify(schedule)}`;
  const every = schedule.everyMs;
  const hours = every / 3_600_000;
  let out = `every=${Number.isInteger(hours) ? `${hours}h` : `${every}ms`}`;
  if (every === 86_400_000 && Number.isFinite(schedule.anchorMs)) {
    const d = new Date(schedule.anchorMs % 86_400_000);
    const utc = d.toISOString().slice(11, 19);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .format(new Date(Date.UTC(2026, 9, 18) + (schedule.anchorMs % 86_400_000)));
    out += ` daily at ${utc} UTC (${local} ${timeZone} in CEST, one hour earlier in CET)`;
  }
  return out;
}
