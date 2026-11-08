const assert = require("node:assert/strict");
const test = require("node:test");
const { slugify, truncate } = require("../src/text");

test("slugify lowercases and joins words with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("Order 66 report"), "order-66-report");
});

test("slugify rejects non-strings", () => {
  assert.throws(() => slugify(42), TypeError);
});

test("truncate", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a long sentence", 6), "a lon…");
});
