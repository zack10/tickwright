const assert = require("node:assert/strict");
const test = require("node:test");
const { paginate } = require("../src/pagination");

test("counts pages", () => {
  assert.equal(paginate([1, 2, 3, 4, 5], 1, 2).totalPages, 3);
  assert.equal(paginate([], 1, 10).totalPages, 0);
});

test("rejects invalid page arguments", () => {
  assert.throws(() => paginate([1], 0, 10), RangeError);
  assert.throws(() => paginate([1], 1, 0), RangeError);
  assert.throws(() => paginate([1], 1.5, 10), RangeError);
});
