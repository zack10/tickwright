const assert = require("node:assert/strict");
const test = require("node:test");
const { paginate } = require("../src/pagination");

const items = Array.from({ length: 25 }, (_, index) => index + 1);

test("page 1 starts at the first item", () => {
  assert.deepEqual(paginate(items, 1, 10).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("later pages follow on without gaps", () => {
  assert.deepEqual(paginate(items, 2, 10).items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(paginate(items, 3, 10).items, [21, 22, 23, 24, 25]);
});

test("hasNext is false on the last page only", () => {
  assert.equal(paginate(items, 2, 10).hasNext, true);
  assert.equal(paginate(items, 3, 10).hasNext, false);
  assert.equal(paginate(items.slice(0, 20), 2, 10).hasNext, false);
});
