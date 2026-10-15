#!/usr/bin/env node
// One-shot: post the three 2026-10-15 baseline failures to #bugs. No-op once bugs.json has __seeded.
import { seedBugs } from "./bugs.mjs";
console.log(`[evals] seed bugs ${JSON.stringify(seedBugs())}`);
