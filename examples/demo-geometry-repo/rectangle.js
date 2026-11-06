/**
 * Rectangle geometry helpers.
 */

/**
 * Compute the area of a rectangle.
 * @param {number} w width
 * @param {number} h height
 * @returns {number} w * h
 */
function area(w, h) {
  return w * h;
}

/**
 * Compute the perimeter of a rectangle.
 * @param {number} w width
 * @param {number} h height
 * @returns {number} 2 * (w + h)
 */
function perimeter(w, h) {
  return 2 * (w + h);
}

module.exports = { area, perimeter };
