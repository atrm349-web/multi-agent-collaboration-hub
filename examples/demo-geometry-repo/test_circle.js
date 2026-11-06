const assert = require("assert");
const circle = require("./circle.js");

assert.strictEqual(typeof circle.area, "function", "circle.area must be a function");
assert.strictEqual(typeof circle.circumference, "function", "circle.circumference must be a function");

const cArea = circle.area(3);
const cCirc = circle.circumference(3);

assert(Math.abs(cArea - Math.PI * 9) < 1e-4, "Circle area mismatch: " + cArea);
assert(Math.abs(cCirc - 2 * Math.PI * 3) < 1e-4, "Circle circumference mismatch: " + cCirc);

console.log("CIRCLE_TESTS_PASSED");
