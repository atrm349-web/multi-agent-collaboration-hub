"use strict";

const assert = require("assert");
const { parseDuration } = require("./src/duration");
const { slaToMillis } = require("./src/report");

// README examples
assert.strictEqual(parseDuration("90s"), 90);
assert.strictEqual(parseDuration("1h30m"), 5400);
assert.strictEqual(parseDuration("2d"), 172800);

// Combined units
assert.strictEqual(parseDuration("2d4h"), 187200);
assert.strictEqual(parseDuration("1d2h3m4s"), 93784);

// Case-insensitive
assert.strictEqual(parseDuration("1H30M"), 5400);
assert.strictEqual(parseDuration("2D"), 172800);
assert.strictEqual(parseDuration("90S"), 90);

// Integer seconds
assert.strictEqual(parseDuration("0s"), 0);
assert.ok(Number.isInteger(parseDuration("1h30m")));

// Invalid inputs throw RangeError containing INVALID_DURATION
const invalid = [
  "",
  "   ",
  "90",        // bare number, no unit
  "1h30",      // trailing bare number
  "-90s",      // negative
  "-1h30m",
  "1x",        // unknown unit
  "1h30x",
  "h",         // unit without number
  "1.5h",      // non-integer
  "1 h",       // whitespace inside
  "1h 30m",
  "abc",
  "1h30m!",
  null,
  undefined,
  90,
  {},
];

for (const value of invalid) {
  assert.throws(
    () => parseDuration(value),
    (err) =>
      err instanceof RangeError && /INVALID_DURATION/.test(err.message),
    `expected RangeError INVALID_DURATION for ${JSON.stringify(value)}`
  );
}

// report.js still works with the module.exports shape
assert.strictEqual(slaToMillis("1h30m"), 5400000);

console.log("all checks passed");
