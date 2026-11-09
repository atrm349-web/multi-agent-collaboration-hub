#!/usr/bin/env node
// Owner acceptance oracle for the DS-04 real end-to-end run.
// Lives OUTSIDE the agent-writable repository: the hub runs this exact argv in
// its own sandbox, so the Agent cannot edit its own gate.
//
// Contract follows repo/README.md exactly, including the edge cases that make a
// naive implementation fail (unit required, case-insensitive, combined units).
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
    console.log(`FAIL parseDuration(${JSON.stringify(input)}): ${error?.message ?? error}`);
  }
}

function throws(input, needle) {
  total += 1;
  try {
    if (typeof parseDuration !== "function") throw new Error("parseDuration is not exported as a function");
    const value = parseDuration(input);
    throw new Error(`expected RangeError but returned ${JSON.stringify(value)}`);
  } catch (error) {
    const ok = error instanceof RangeError && String(error.message).includes(needle);
    if (ok) {
      console.log(`PASS parseDuration(${JSON.stringify(input)}) threw RangeError(${needle})`);
    } else {
      failed += 1;
      console.log(`FAIL parseDuration(${JSON.stringify(input)}): ${error?.name}: ${error?.message}`);
    }
  }
}

eq("90s", 90);
eq("1h30m", 5400);
eq("2d", 172800);
eq("1H30M", 5400);
eq("2d4h", 187200);
eq("45m", 2700);
throws("90", "INVALID_DURATION");
throws("", "INVALID_DURATION");
throws("abc", "INVALID_DURATION");
throws("-5m", "INVALID_DURATION");

console.log(`--- ${total - failed}/${total} checks passed (${modulePath})`);
process.exit(failed === 0 && total > 0 ? 0 : 1);
