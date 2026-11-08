const assert = require("node:assert/strict");
const test = require("node:test");

const { reviewOutcome } = require("../dist/services/agentGraph/reviewer");

const rejected = { approved: false, issues: ["NextRun is unchanged"], summary: "Rejected", suggestions: ["rename x"] };

test("an approved change goes to publish approval with its suggestions and no objections", () => {
  assert.deepEqual(reviewOutcome({ approved: true, issues: [], summary: "ok", suggestions: ["rename x"] }, true), {
    route: "artifact",
    reviewSuggestions: ["rename x"],
    reviewObjections: [],
  });
});

test("objections with attempts left go to the next attempt", () => {
  assert.deepEqual(reviewOutcome(rejected, true), { route: "retry", lastFailure: "NextRun is unchanged" });
});

test("objections on the last attempt go to the approver instead of blocking", () => {
  assert.deepEqual(reviewOutcome(rejected, false), {
    route: "artifact",
    reviewSuggestions: ["rename x"],
    reviewObjections: ["NextRun is unchanged"],
  });
  // A rejection without listed issues still tells the approver why.
  assert.deepEqual(reviewOutcome({ approved: false, issues: [], summary: "No verdict" }, false).reviewObjections, ["No verdict"]);
});
