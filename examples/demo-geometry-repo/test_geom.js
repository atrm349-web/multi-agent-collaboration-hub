const assert = require("assert");
const circle = require("./circle.js");
const rectangle = require("./rectangle.js");

assert(Math.abs(circle.area(3) - Math.PI * 9) < 1e-4, "Integrated circle area check");
assert.strictEqual(rectangle.area(4, 5), 20, "Integrated rectangle area check");

console.log("INTEGRATED_GEOMETRY_TESTS_PASSED");
