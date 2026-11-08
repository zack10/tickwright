const assert = require("node:assert/strict");
const test = require("node:test");
const { slugify } = require("../src/text");

test("accents are removed, not replaced", () => {
  assert.equal(slugify("Crème Brûlée"), "creme-brulee");
  assert.equal(slugify("Ångström façade"), "angstrom-facade");
});

test("no leading or trailing dashes", () => {
  assert.equal(slugify("  Hello World!  "), "hello-world");
  assert.equal(slugify("--Already--dashed--"), "already-dashed");
});

test("input without letters or digits gives an empty slug", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("!!!"), "");
});

test("plain titles still work", () => {
  assert.equal(slugify("Order 66 report"), "order-66-report");
});
