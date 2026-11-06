"use strict";

/**
 * Circle geometry helpers.
 */

/**
 * Area of a circle.
 * @param {number} r radius
 * @returns {number} Math.PI * r * r
 */
function area(r) {
  return Math.PI * r * r;
}

/**
 * Circumference of a circle.
 * @param {number} r radius
 * @returns {number} 2 * Math.PI * r
 */
function circumference(r) {
  return 2 * Math.PI * r;
}

module.exports = { area, circumference };
