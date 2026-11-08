const assert = require("node:assert/strict");
const test = require("node:test");
const { AREAS, shippingCost } = require("../src/shippingRates");

test("a weight exactly on a limit uses that tier", () => {
  assert.equal(shippingCost("10120", 1), 700);
  assert.equal(shippingCost("10120", 5), 1400);
  assert.equal(shippingCost("10120", 20), 2900);
});

test("just over a limit moves to the next tier", () => {
  assert.equal(shippingCost("10120", 1.01), 1400);
  assert.throws(() => shippingCost("10120", 20.01), RangeError);
});

test("the area table is intact", () => {
  assert.equal(AREAS.length, 400);
  assert.equal(AREAS[399].prefix, "499");
  assert.equal(AREAS[399].district, "District 499");
});
