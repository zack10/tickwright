const assert = require("node:assert/strict");
const test = require("node:test");
const { parseCsv } = require("../src/csv");

test("parses a header and rows", () => {
  assert.deepEqual(parseCsv("name,email\nAda,ada@example.com\nAlan,alan@example.com\n"), [
    { name: "Ada", email: "ada@example.com" },
    { name: "Alan", email: "alan@example.com" },
  ]);
});

test("empty input has no rows", () => {
  assert.deepEqual(parseCsv(""), []);
});
