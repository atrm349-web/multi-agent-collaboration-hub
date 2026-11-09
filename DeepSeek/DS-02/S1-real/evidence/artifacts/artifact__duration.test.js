"use strict";

// Local verification for parseDuration (README rules 1-9).
// Run with: node test/duration.test.js

const assert = require("assert");
const { parseDuration } = require("../src/duration.js");

const valid = [
  ["90s", 90],
  ["1h30m", 5400],
  ["2d4h", 2 * 86400 + 4 * 3600],
  ["1H30M", 5400],
  ["1h 30m", 5400],
  ["1w", 604800],
  ["1w 2d 3h 4m 5s", 604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
  ["0s", 0],
  ["1h30m15s", 3600 + 1800 + 15],
  ["2D4H", 2 * 86400 + 4 * 3600],
  ["1m", 60],
  ["1d", 86400],
];

const invalid = [
  "1 h",
  "90",
  "1.5h",
  "",
  " ",
  "1h  30m",
  " 1h",
  "1h ",
  "-1h",
  "1x",
  "1h30",
  "999999999999999999999s",
  "1h 999999999999999999999s",
  "1h30m ",
  "1h\t30m",
  "1h30mx",
  "h",
  "1hh",
  "1h-30m",
  "1h+30m",
  "1e3s",
  "0x10s",
  "1h 30",
  "1h30m 1 h",
];

let failures = 0;

for (const [input, expected] of valid) {
  try {
    const got = parseDuration(input);
    if (got !== expected) {
      failures++;
      console.log(`FAIL valid ${JSON.stringify(input)}: got ${got}, want ${expected}`);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL valid ${JSON.stringify(input)} threw ${err.message}`);
  }
}

for (const input of invalid) {
  try {
    parseDuration(input);
    failures++;
    console.log(`FAIL invalid ${JSON.stringify(input)} did not throw`);
  } catch (err) {
    if (!(err instanceof RangeError) || !err.message.includes("INVALID_DURATION")) {
      failures++;
      console.log(`FAIL invalid ${JSON.stringify(input)} wrong error: ${err}`);
    }
  }
}

// Non-string inputs must also be rejected.
for (const input of [undefined, null, 90, {}, [], true]) {
  try {
    parseDuration(input);
    failures++;
    console.log(`FAIL non-string ${String(input)} did not throw`);
  } catch (err) {
    if (!(err instanceof RangeError) || !err.message.includes("INVALID_DURATION")) {
      failures++;
      console.log(`FAIL non-string ${String(input)} wrong error: ${err}`);
    }
  }
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
