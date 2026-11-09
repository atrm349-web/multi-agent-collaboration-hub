"use strict";

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

// One or more "<integer><unit>" segments, e.g. "1h30m", "2d4h", "90s".
const SEGMENT_RE = /^(\d+)([smhd])$/i;

/**
 * Build the error thrown for any invalid duration input.
 * @param {*} text
 * @returns {RangeError}
 */
function invalidDuration(text) {
  return new RangeError(`INVALID_DURATION: ${JSON.stringify(String(text))}`);
}

/**
 * Duration parsing for the reporting service.
 *
 * Accepts one or more `<number><unit>` segments where the unit is one of
 * `s`, `m`, `h`, `d` (case-insensitive). A unit is required for every
 * segment. Returns the total number of seconds as an integer.
 *
 * @param {string} text
 * @returns {number} total seconds
 * @throws {RangeError} when the input is empty, malformed, negative,
 *   unit-less, or uses an unknown unit; the message contains INVALID_DURATION.
 */
function parseDuration(text) {
  if (typeof text !== "string") {
    throw invalidDuration(text);
  }

  const input = text.trim();
  if (input === "") {
    throw invalidDuration(text);
  }

  // Split into number/unit segments; anything left over is malformed.
  const segments = input.match(/\d+[a-z]*|[a-z]+/gi);
  if (!segments || segments.join("") !== input) {
    throw invalidDuration(text);
  }

  let total = 0;
  for (const segment of segments) {
    const match = SEGMENT_RE.exec(segment);
    if (!match) {
      // Covers bare numbers (no unit), unknown units, and stray characters.
      throw invalidDuration(text);
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = UNIT_SECONDS[unit];
    if (!Number.isSafeInteger(value) || multiplier === undefined) {
      throw invalidDuration(text);
    }

    total += value * multiplier;
    if (!Number.isSafeInteger(total)) {
      throw invalidDuration(text);
    }
  }

  return total;
}

module.exports = { parseDuration };
