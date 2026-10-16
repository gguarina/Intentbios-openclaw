#!/usr/bin/env node
// Daily scorecard (automation command payload; stdout is announced to #alerts). Runs the golden set,
// compares with the baseline, adds dev metrics and spend. Flags regressions and PROPOSES reverts only.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EVAL_DIR, runGolden, readBaseline, saveRun } from "./coach-golden.mjs";
import { fileRunBugs } from "./bugs.mjs";

const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const lines = [];
const flags = [];

// 1. Coach golden set
const base = readBaseline();
let run = null;
try {
  run = await runGolden({ baseline: base });
  saveRun(run);
  lines.push(`**Coach golden set** (intentbios-coach, flash/off): pass ${pct(run.passRate)} vs baseline ${pct(base?.passRate)}, judge ${run.meanJudge?.toFixed(2) ?? "-"} vs ${base?.meanJudge?.toFixed(2) ?? "-"}, latency p50 ${run.p50}ms / p95 ${run.p95}ms (baseline ${base?.p50 ?? "-"}/${base?.p95 ?? "-"})`);
  const failed = run.turns.filter((t) => !t.pass).map((t) => `${t.id}${Object.entries(t.checks).filter(([, v]) => !v).map(([k]) => ` !${k}`).join("")}${t.judge?.score != null ? ` j=${t.judge.score}` : ""}`);
  if (failed.length) lines.push(`Failing: ${failed.join("; ")}`);
  const filed = fileRunBugs(run, base);
  if (filed.length) lines.push(`#bugs: ${filed.map((f) => `${f.turnId} ${f.action}`).join(", ")}`);
  if (base && (run.passRate < base.passRate || (run.meanJudge != null && base.meanJudge != null && run.meanJudge < base.meanJudge - 0.5))) {
    flags.push("intentbios-coach quality is below baseline. Proposal: revert intentbios-coach to its previous setting (deepseek-v4-flash, thinking high). Not applied; Gustavo decides.");
  }
} catch (err) {
  lines.push(`Coach golden set failed to run: ${err.message}`);
}

// 2. Dev metrics (last 24h vs all earlier)
try {
  const all = fs.readFileSync(path.join(EVAL_DIR, "dev.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cut = Date.now() - 24 * 3600e3;
  const day = all.filter((d) => Date.parse(d.at) >= cut), prev = all.filter((d) => Date.parse(d.at) < cut);
  const rate = (xs, k) => { const v = xs.filter((d) => typeof d[k] === "boolean"); return v.length ? v.filter((d) => d[k]).length / v.length : null; };
  const mins = day.map((d) => d.durationMin).filter(Number.isFinite).sort((a, b) => a - b);
  lines.push(`**#dev (24h)**: ${day.length} tasks, planner used ${pct(rate(day, "plannerUsed"))}, tests green first try ${pct(rate(day, "testsGreenFirstTry"))} (before: ${pct(rate(prev, "testsGreenFirstTry"))}), replay fixed ${pct(rate(day, "replayFixed"))}, escalated to pro ${pct(rate(day, "escalatedToPro"))}, median ${mins.length ? mins[Math.floor(mins.length / 2)] : "-"} min`);
  const g = rate(day, "testsGreenFirstTry"), gp = rate(prev, "testsGreenFirstTry");
  if (day.length >= 3 && g != null && gp != null && g < gp - 0.2) flags.push("main coding (flash/low) first-try green rate dropped >20 pts. Proposal: raise main thinking to medium or high. Not applied; Gustavo decides.");
  const e = rate(day, "escalatedToPro");
  if (day.length >= 3 && e != null && e > 0.5) flags.push("Over half of #dev tasks escalated to pro. Proposal: move main coding to pro or thinking medium. Not applied.");
} catch {
  lines.push("**#dev (24h)**: no dev.jsonl entries yet");
}

// 3. Spend: DeepSeek balance delta + OpenClaw session usage + call counts from today's log
const spend = [];
try {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (key) {
    const r = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` } });
    const j = await r.json();
    const info = (j.balance_infos || [])[0];
    if (info) {
      const file = path.join(EVAL_DIR, "balance.jsonl");
      const hist = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const now = { at: new Date().toISOString(), currency: info.currency, total: Number(info.total_balance) };
      fs.appendFileSync(file, JSON.stringify(now) + "\n");
      const last = hist.at(-1);
      spend.push(last && last.currency === now.currency
        ? `DeepSeek balance ${now.total.toFixed(2)} ${now.currency}, spent ${(last.total - now.total).toFixed(2)} since ${last.at.slice(0, 16)}Z (top-ups distort this)`
        : `DeepSeek balance ${now.total.toFixed(2)} ${now.currency} (first snapshot; spend from tomorrow)`);
    }
  }
} catch (err) { spend.push(`balance unavailable (${err.message})`); }
try {
  // The human-readable output of usage-cost prints zeros; only --json carries the ledger.
  const out = execFileSync("openclaw", ["gateway", "usage-cost", "--days", "1", "--all-agents", "--json"], { encoding: "utf8", timeout: 60_000 });
  const totals = JSON.parse(out)?.totals || {};
  const n = (x) => Number(x || 0).toLocaleString("en-US");
  spend.push(`OpenClaw usage (1d): $${Number(totals.totalCost || 0).toFixed(2)} · ${n(totals.totalTokens)} tokens (in ${n(totals.input)}, out ${n(totals.output)}, cache-read ${n(totals.cacheRead)})`);
} catch { spend.push("OpenClaw usage-cost unavailable"); }
try {
  const dir = "/tmp/openclaw";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort().slice(-2);
  const counts = {};
  for (const f of files) for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/model-fetch\] start provider=\S+ api=\S+ model=(\S+)/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  if (Object.keys(counts).length) spend.push(`model calls (log since last restart): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
} catch { /* no log file */ }
lines.push(`**Spend**: ${spend.join("; ") || "-"}`);

if (flags.length) lines.push("⚠️ **Regression**:\n- " + flags.join("\n- "));
console.log([`📊 Daily scorecard ${new Date().toISOString().slice(0, 10)}`, ...lines].join("\n"));
