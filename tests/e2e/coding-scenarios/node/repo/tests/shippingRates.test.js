const assert = require("node:assert/strict");
const test = require("node:test");
const { AREAS, findArea, shippingCost } = require("../src/shippingRates");

test("every prefix from 100 to 499 has an area", () => {
  assert.equal(AREAS.length, 400);
  assert.equal(findArea("49812").district, "District 498");
});

test("prices light and medium parcels by zone", () => {
  assert.equal(shippingCost("10120", 0.5), 700); // zone C
  assert.equal(shippingCost("10320", 3), 1100); // zone B
  assert.equal(shippingCost("10220", 3), 1400); // zone A, remote surcharge
});

test("rejects unknown areas and bad weights", () => {
  assert.throws(() => shippingCost("99999", 1), RangeError);
  assert.throws(() => shippingCost("10120", 0), RangeError);
});
