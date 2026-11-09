#!/usr/bin/env node
// DS-02 real-model acceptance oracle (strict by design: the README lists every
// rule, so a failure means the implementation missed a stated requirement — that
// is exactly the "real model did not meet the standard" condition we want).
// Lives outside the repository so the Agent cannot weaken it.
import { pathToFileURL } from "node:url";
import path from "node:path";

const modulePath = path.join(process.cwd(), "src", "duration.js");
let mod;
try {
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.log(`FAIL import src/duration.js: ${error?.message ?? error}`);
  process.exit(1);
}

const { parseDuration } = mod;
let failed = 0;
let total = 0;

function eq(input, expected) {
  total += 1;
  try {
    if (typeof parseDuration !== "function") throw new Error("parseDuration is not exported as a function");
    const actual = parseDuration(input);
    if (actual !== expected) throw new Error(`expected ${expected} but got ${JSON.stringify(actual)}`);
    console.log(`PASS parseDuration(${JSON.stringify(input)}) === ${expected}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL parseDuration(${JSON.stringify(input)}): expected ${expected} — ${error?.message ?? error}`);
  }
}

function throws(input, needle = "INVALID_DURATION") {
  total += 1;
  try {
    if (typeof parseDuration !== "function") throw new Error("parseDuration is not exported as a function");
    const value = parseDuration(input);
    throw new Error(`expected RangeError(${needle}) but returned ${JSON.stringify(value)}`);
  } catch (error) {
    const ok = error instanceof RangeError && String(error.message).includes(needle);
    if (ok) console.log(`PASS parseDuration(${JSON.stringify(input)}) threw RangeError(${needle})`);
    else {
      failed += 1;
      console.log(`FAIL parseDuration(${JSON.stringify(input)}): ${error?.name}: ${error?.message}`);
    }
  }
}

eq("90s", 90);
eq("1h30m", 5400);
eq("2d", 172800);
eq("1H30M", 5400);
eq("1h 30m", 5400);        // rule 4: single space between segments is allowed
eq("1w", 604800);          // rule 1: weeks
eq("2d4h", 187200);
throws("1 h", "INVALID_DURATION");            // rule 4: space inside a segment
throws("90", "INVALID_DURATION");             // rule 5
throws("1.5h", "INVALID_DURATION");           // rule 6
throws("-5m", "INVALID_DURATION");
throws("abc", "INVALID_DURATION");
throws("999999999999999999999s", "INVALID_DURATION"); // rule 7: overflow

console.log(`--- ${total - failed}/${total} checks passed (${modulePath})`);
process.exit(failed === 0 && total > 0 ? 0 : 1);
