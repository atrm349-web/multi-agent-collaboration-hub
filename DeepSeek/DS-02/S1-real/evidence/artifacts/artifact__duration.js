"use strict";

/**
 * Duration parsing for the reporting service.
 *
 * Grammar (README rules 1-9):
 *   duration := segment ( " "? segment )*
 *   segment  := digits unit
 *   unit     := "s" | "m" | "h" | "d" | "w"   (case-insensitive)
 *
 * - No bare numbers, no decimals, no negatives, no empty input.
 * - A single space is allowed *between* segments only, never between a
 *   number and its unit.
 * - The total must fit in a safe integer, otherwise it is invalid.
 *
 * @param {string} text
 * @returns {number} total seconds
 */

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

function invalid() {
  return new RangeError("INVALID_DURATION");
}

function parseDuration(text) {
  if (typeof text !== "string") {
    throw invalid();
  }

  // Reject empty input up front.
  if (text.length === 0) {
    throw invalid();
  }

  // Split on single spaces between segments. Consecutive spaces, leading or
  // trailing spaces produce empty segments and are therefore rejected below.
  const segments = text.split(" ");

  let total = 0;

  for (const segment of segments) {
    // Empty segment => leading/trailing space or double space.
    if (segment.length === 0) {
      throw invalid();
    }

    // A segment is one or more "digits unit" pairs concatenated together,
    // e.g. "1h30m". Anything else (bare numbers, decimals, negatives,
    // unknown units, spaces inside a segment) fails to match.
    const pairPattern = /([0-9]+)([smhdw])/gi;
    let consumed = 0;
    let pairCount = 0;
    let match;

    while ((match = pairPattern.exec(segment)) !== null) {
      // Reject gaps: the match must start exactly where the previous one ended.
      if (match.index !== consumed) {
        throw invalid();
      }
      consumed = pairPattern.lastIndex;
      pairCount++;

      const amountText = match[1];
      const unit = match[2].toLowerCase();

      // Reject values that cannot be represented exactly as a safe integer.
      const amount = Number(amountText);
      if (!Number.isSafeInteger(amount)) {
        throw invalid();
      }

      const segmentSeconds = amount * UNIT_SECONDS[unit];
      if (!Number.isSafeInteger(segmentSeconds)) {
        throw invalid();
      }

      total += segmentSeconds;
      if (!Number.isSafeInteger(total)) {
        throw invalid();
      }
    }

    // The whole segment must be covered by "digits unit" pairs.
    if (pairCount === 0 || consumed !== segment.length) {
      throw invalid();
    }
  }

  return total;
}

module.exports = { parseDuration };
