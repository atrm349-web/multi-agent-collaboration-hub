#!/usr/bin/env node
// DS-02 owner acceptance test — lives OUTSIDE the agent-writable repository.
// The hub runs this exact argv under a restricted OS sandbox with the agent's
// code copy as cwd. Nothing here is available to the Agent for editing, which
// is what makes it an independent oracle.
//
// Contract (strict on purpose, the task goal is deliberately incomplete):
//   formatAmount(1234)   === '¥12.34'
//   formatAmount(5)      === '¥0.05'
//   formatAmount(123456) === '¥1,234.56'   // thousands separator
//   formatAmount(-1234)  === '-¥12.34'     // sign before the currency symbol
//   formatAmount(1.5)    throws RangeError whose message contains INVALID_AMOUNT
//
// stdout: one line per check. stderr: FAIL lines with expected/actual, so the
// rework instruction carries actionable evidence to the next attempt.

import { pathToFileURL } from "node:url";
import path from "node:path";

const cwd = process.cwd();
const modulePath = path.join(cwd, "src", "amount.mjs");

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? " :: " + detail : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail: message });
    console.log(`FAIL ${name} :: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

let mod;
let loadError = null;
try {
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  loadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.log(`FAIL import src/amount.mjs :: ${loadError}`);
  console.error(`FAIL import src/amount.mjs: ${loadError}`);
}

const formatAmount = mod?.formatAmount;

function expectEqual(args, expected) {
  if (typeof formatAmount !== "function") {
    throw new Error(`formatAmount is not exported as a function (got ${typeof formatAmount})`);
  }
  const actual = formatAmount(...args);
  if (actual !== expected) {
    throw new Error(
      `formatAmount(${args.map((v) => JSON.stringify(v)).join(", ")}) expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
  return `${JSON.stringify(args[0])} -> ${JSON.stringify(expected)}`;
}

if (!loadError) {
  check("basic two-decimal formatting", () => expectEqual([1234], "¥12.34"));
  check("leading zero for sub-unit amounts", () => expectEqual([5], "¥0.05"));
  check("thousands separator", () => expectEqual([123456], "¥1,234.56"));
  check("negative sign precedes currency symbol", () => expectEqual([-1234], "-¥12.34"));
  check("non-integer input rejects with INVALID_AMOUNT", () => {
    if (typeof formatAmount !== "function") {
      throw new Error(`formatAmount is not exported as a function (got ${typeof formatAmount})`);
    }
    let threw = null;
    try {
      formatAmount(1.5);
    } catch (error) {
      threw = error;
    }
    if (!threw) throw new Error("formatAmount(1.5) expected RangeError containing 'INVALID_AMOUNT' but nothing was thrown");
    if (!(threw instanceof RangeError)) {
      throw new Error(`formatAmount(1.5) expected RangeError containing 'INVALID_AMOUNT' but threw ${threw?.name ?? typeof threw}`);
    }
    if (!String(threw.message).includes("INVALID_AMOUNT")) {
      throw new Error(`formatAmount(1.5) threw RangeError but message lacks 'INVALID_AMOUNT': ${JSON.stringify(threw.message)}`);
    }
    return "throws RangeError(INVALID_AMOUNT)";
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`--- ${results.length - failed.length}/${results.length} checks passed (module: ${modulePath})`);
if (loadError || !results.length || failed.length) process.exit(1);
process.exit(0);
