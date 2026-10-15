#!/usr/bin/env node
// Append one #dev task line: node /app/evals/dev-log.mjs --task "<short>" --pr <url> --planner yes|no
//   --green-first yes|no --replay-fixed yes|no|na --escalated yes|no --minutes <n>
import fs from "node:fs";
import path from "node:path";
const DIR = process.env.EVAL_DIR || "/data/workspace/evals";
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const yn = (v) => (v === "yes" ? true : v === "no" ? false : null);
const line = {
  at: new Date().toISOString(), task: get("task") || "", pr: get("pr") || null,
  plannerUsed: yn(get("planner")), testsGreenFirstTry: yn(get("green-first")), replayFixed: yn(get("replay-fixed")),
  escalatedToPro: yn(get("escalated")), durationMin: Number(get("minutes")) || null,
};
fs.mkdirSync(DIR, { recursive: true });
fs.appendFileSync(path.join(DIR, "dev.jsonl"), JSON.stringify(line) + "\n");
console.log(JSON.stringify(line));
