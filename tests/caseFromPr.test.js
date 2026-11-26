const assert = require("node:assert/strict");
const test = require("node:test");

const { outcomeProblem, splitDiff } = require("../scripts/caseFromPr");

const fileDiff = (file, line) => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${line}\n`;

test("a merged diff is cut into the fix and the hidden tests by the repository's test-file rule", () => {
  const diff = fileDiff("src/a.go", "fixed") + fileDiff("src/a_test.go", "new test") + fileDiff("README.md", "doc");
  const parts = splitDiff(diff, (file) => file.endsWith("_test.go"));

  assert.equal(parts.fix, fileDiff("src/a.go", "fixed") + fileDiff("README.md", "doc"));
  assert.equal(parts.hidden, fileDiff("src/a_test.go", "new test"));
  assert.deepEqual(parts.testFiles, ["src/a_test.go"]);
});

test("only a pull request merged after a person changed it gives a case", () => {
  assert.match(outcomeProblem(undefined), /no recorded outcome/);
  assert.match(outcomeProblem({ state: "CLOSED", mergedAsWritten: false }), /closed, not merged/);
  assert.match(outcomeProblem({ state: "MERGED", mergedAsWritten: true }), /merged as written/);
  assert.equal(outcomeProblem({ state: "MERGED", mergedAsWritten: false }), undefined);
  // After follow-up rounds the comparison is not made, so the PR may still have been corrected.
  assert.equal(outcomeProblem({ state: "MERGED", mergedAsWritten: null }), undefined);
});
