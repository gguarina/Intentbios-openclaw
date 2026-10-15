// Files failing golden-set turns into Discord #bugs, deduplicated for 7 days per turn (or fingerprint).
// State: /data/workspace/evals/bugs.json { [turnId]: { messageId, fingerprint, firstAt, lastAt, seen } }.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EVAL_DIR } from "./coach-golden.mjs";

export const BUGS_CHANNEL_ID = "1560230071350992896";
const STATE = path.join(EVAL_DIR, "bugs.json");
const WEEK = 7 * 24 * 3600e3;
const ASK = "→ Open a #dev thread, reproduce on `gustavo-test`, fix, PR, deploy, then re-run the eval (`node /app/evals/coach-golden.mjs`).";

export const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (s) => { fs.mkdirSync(EVAL_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const quote = (s, n = 220) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

export function failedChecks(turn, baselineTurn) {
  const f = Object.entries(turn.checks || {}).filter(([, v]) => !v).map(([k]) => k);
  const s = turn.judge?.score;
  if (typeof s === "number" && (s < 3 || (typeof baselineTurn?.judge?.score === "number" && s < baselineTurn.judge.score - 1))) f.push(`judge=${s}${baselineTurn?.judge?.score != null ? ` (baseline ${baselineTurn.judge.score})` : ""}`);
  if (turn.status && turn.status !== 200) f.push(`http=${turn.status}`);
  return f;
}
export const fingerprint = (turnId, failed, reply) => `${turnId}|${failed.map((x) => x.replace(/=.*/, "")).sort().join(",")}|${quote(reply, 60).toLowerCase()}`;

export function bugText({ title, turnId, intentId, failed, reply, note, seen = 1, firstAt }) {
  return [
    `🐞 **Golden-set failure: \`${turnId}\`**${title ? ` — ${title}` : ""}`,
    `Intent: ${intentId ? `\`${intentId}\`` : "-"} (user \`gustavo-test\`)`,
    `Failed checks: ${failed.length ? failed.map((f) => `\`${f}\``).join(", ") : "-"}`,
    `Reply: > ${quote(reply)}`,
    note ? `Note: ${note}` : null,
    seen > 1 ? `Seen ${seen}× since ${String(firstAt).slice(0, 10)} (last ${new Date().toISOString().slice(0, 10)})` : null,
    ASK,
  ].filter(Boolean).join("\n");
}

function discord(args) {
  const out = execFileSync("openclaw", ["message", ...args, "--channel", "discord", "--account", "default", "--target", `channel:${BUGS_CHANNEL_ID}`, "--json"], { encoding: "utf8", timeout: 60_000 });
  const m = out.match(/"(?:messageId|message_id|id)"\s*:\s*"?(\d{10,25})/);
  return m ? m[1] : null;
}

/** Post or update one bug. Returns { action: "posted"|"updated"|"skipped", messageId }. */
export function fileBug(bug, state = readState()) {
  const fp = fingerprint(bug.turnId, bug.failed, bug.reply);
  const now = new Date().toISOString();
  const prev = state[bug.turnId] || Object.values(state).find((e) => e.fingerprint === fp);
  if (prev && Date.now() - Date.parse(prev.lastAt || prev.firstAt) < WEEK) {
    if (prev.lastAt?.slice(0, 10) === now.slice(0, 10) && prev.fingerprint === fp) return { action: "skipped", messageId: prev.messageId };
    const seen = (prev.seen || 1) + 1;
    bug = { ...bug, title: bug.title || prev.title };
    try { if (prev.messageId) discord(["edit", "--message-id", prev.messageId, "--message", bugText({ ...bug, seen, firstAt: prev.firstAt })]); } catch { /* keep state */ }
    state[bug.turnId] = { ...prev, fingerprint: fp, lastAt: now, seen };
    writeState(state);
    return { action: "updated", messageId: prev.messageId };
  }
  const messageId = discord(["send", "--message", bugText(bug)]);
  state[bug.turnId] = { messageId, fingerprint: fp, firstAt: now, lastAt: now, seen: 1, title: bug.title || null };
  writeState(state);
  return { action: "posted", messageId };
}

/** All non-PASS turns of a run. */
export function fileRunBugs(run, baseline) {
  const state = readState();
  const results = [];
  for (const t of run.turns.filter((x) => !x.pass)) {
    const failed = failedChecks(t, baseline?.turns?.find((b) => b.id === t.id));
    if (!failed.length) failed.push("not PASS (judge below baseline)");
    try { results.push({ turnId: t.id, ...fileBug({ turnId: t.id, intentId: t.intentId, failed, reply: t.reply }, state) }); }
    catch (err) { results.push({ turnId: t.id, action: "error", error: String(err.message).slice(0, 200) }); }
  }
  return results;
}

// One-shot seed from the 2026-10-15 baseline (three distinct failures). Each seed also covers the
// sibling turns that fail the same way, so the daily job updates these posts instead of re-posting.
export const SEEDS = [
  { key: "seed-berlin-canned", turnId: "rooms", covers: ["berlin-create", "rooms", "persons", "what-step", "stuck"], title: "Berlin coach ignores answers (canned reply)",
    failed: ["judge=2", "conditions not applied (3 rooms / 3 persons)", "generic suggestedReplies"],
    reply: "Current step is Search for an apartment (INFORM). The system can run this step. Ask can coach this step; it does not mark it complete. Current block: Overview.",
    note: "Same canned reply after \"3 rooms\" and \"3 persons\"; suggested replies stay generic (What should I do on this step? / I'm stuck / Explain this step simply)." },
  { key: "seed-journey-dump", turnId: "algebra", covers: ["algebra", "checklist", "schedule", "no-skill"], title: "New intents answer with internal node dump",
    failed: ["judge=2", "internal debug text shown to user", "no coachCard summary/deepLink"],
    reply: "Updated journey nodes: frame_intent, gather_inputs.",
    note: "Seen for algebra, checklist, schedule and no-skill intakes (\"Solve 2x + 6 = 14 for x\")." },
  { key: "seed-bahncard", turnId: "choice", covers: ["choice"], title: "BahnCard choice gets apartment wording",
    failed: ["wrong-domain prompt", "no coachCard summary/deepLink"],
    reply: "Tell me your budget, commute limit, or next constraint to advance the journey.",
    note: "Intent \"Help me choose between a BahnCard 25 and a BahnCard 50\" is asked for apartment constraints (budget/commute)." },
];

export function seedBugs() {
  const state = readState();
  if (state.__seeded) return { already: true, ids: state.__seeded };
  const ids = {};
  for (const s of SEEDS) {
    const messageId = discord(["send", "--message", bugText({ ...s, intentId: null })]);
    const now = new Date().toISOString();
    for (const t of s.covers) state[t] = { messageId, fingerprint: `${s.key}|${t}`, firstAt: now, lastAt: now, seen: 1, title: s.title };
    ids[s.key] = messageId;
  }
  state.__seeded = ids;
  writeState(state);
  return { already: false, ids };
}
