const assert = require("assert");
const rectangle = require(require("node:path").join(process.cwd(), "rectangle.js"));

assert.strictEqual(typeof rectangle.area, "function", "rectangle.area must be a function");
assert.strictEqual(typeof rectangle.perimeter, "function", "rectangle.perimeter must be a function");

const rArea = rectangle.area(4, 5);
const rPerim = rectangle.perimeter(4, 5);

assert.strictEqual(rArea, 20, "Rectangle area mismatch: " + rArea);
assert.strictEqual(rPerim, 18, "Rectangle perimeter mismatch: " + rPerim);

console.log("RECTANGLE_TESTS_PASSED");
