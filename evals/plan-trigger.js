const res = await exec({ command: "node /app/evals/plan-gate.mjs check" });
const out = String(res?.aggregated ?? res?.stdout ?? "").trim().split("\n").filter(Boolean).pop() || "{}";
let r = {};
try { r = JSON.parse(out); } catch { r = { fire: false, reason: "gate output unreadable" }; }
json({ fire: r.fire === true, message: r.message, state: { at: new Date().toISOString(), reason: r.reason || null } });
