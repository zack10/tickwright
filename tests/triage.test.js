const assert = require("node:assert/strict");
const test = require("node:test");

const { describeApprovedPlan, describeRevisions, numberedRequirements, planFromReply, triageDecision } = require("../dist/services/agentGraph/planning");

test("triage only declines on an explicit decline", () => {
  assert.deepEqual(triageDecision({ decision: "decline", reason: "needs a key" }), { decision: "decline", reason: "needs a key" });
  assert.equal(triageDecision({ decision: "proceed", reason: "ok" }).decision, "proceed");
  assert.equal(triageDecision({ decision: "ask" }).decision, "proceed", "the plan carries questions now");
  assert.equal(triageDecision({}).decision, "proceed", "an unclear reply proceeds");
});

test("a plan keeps what the model wrote and invents nothing", () => {
  const plan = planFromReply(
    {
      summary: " Skip missed nights. ",
      expectedBehaviour: ["back Monday 09:00 -> next run Tuesday 02:00", "", 3],
      questions: ["if you meant one catch-up run, Monday 09:00"],
      filesToEdit: ["schedule/schedule.go"],
      risk: "low",
      testStrategy: ["test"],
    },
    "Nightly job ran several times",
  );
  assert.equal(plan.summary, "Skip missed nights.");
  assert.deepEqual(plan.expectedBehaviour, ["back Monday 09:00 -> next run Tuesday 02:00"]);
  assert.equal(plan.risk, "low");

  const empty = planFromReply({ risk: "whatever" }, "Nightly job ran several times");
  assert.equal(empty.summary, "Investigate and change: Nightly job ran several times");
  assert.deepEqual(empty.expectedBehaviour, []);
  assert.equal(empty.risk, "unknown");
});

const stored = (version, plan, snapshotHash) => ({
  version,
  summary: plan.summary,
  acceptanceCriteria: plan.expectedBehaviour,
  snapshotHash,
  tasks: [{ expectedOutput: plan }],
});

test("a revision sees each earlier plan with the feedback it got", () => {
  const first = stored(1, planFromReply({ summary: "Run once at recovery.", expectedBehaviour: ["back 09:00 -> runs 09:00"] }, "t"), "h1");
  const text = describeRevisions([first], [{ snapshotHash: "h1", actor: "trello:zack", comment: "No, wait until Tuesday 02:00" }]);
  assert.match(text, /Plan version 1: Run once at recovery\./);
  assert.match(text, /- back 09:00 -> runs 09:00/);
  assert.match(text, /Feedback from trello:zack: No, wait until Tuesday 02:00/);
  assert.match(describeRevisions([], []), /first plan/);
});

test("the run follows the approved plan without its questions, plus the approver's note", () => {
  const plan = stored(2, planFromReply({ summary: "Skip.", expectedBehaviour: ["a"], questions: ["q"], filesToEdit: ["f"] }, "t"), "h2");
  const followed = JSON.parse(describeApprovedPlan(plan, { comment: "keep the log line" }));
  assert.deepEqual(followed, { summary: "Skip.", expectedBehaviour: ["a"], filesToEdit: ["f"], risk: "unknown", testStrategy: [], approverNote: "keep the log line" });
  // A plan submitted through the API has no written plan: its criteria are the examples.
  const manual = { version: 1, summary: "Manual", acceptanceCriteria: ["x"], snapshotHash: "h", tasks: [{ expectedOutput: {} }] };
  assert.deepEqual(JSON.parse(describeApprovedPlan(manual, undefined)).expectedBehaviour, ["x"]);
});

// Limitation 64: 5 of 5 point-5 plans dropped a requirement the ticket stated, and the reviewer judged against the plan only.
test("the approved plan carries the ticket's stated requirements, numbered, so the reviewer answers each", () => {
  const plan = stored(1, { ...planFromReply({ summary: "Log it.", expectedBehaviour: ["a"] }, "t"), requirements: ["P2002 answers 409", "Test each"] }, "h");
  assert.deepEqual(JSON.parse(describeApprovedPlan(plan, undefined)).requirements, ["1. P2002 answers 409", "2. Test each"]);
  assert.equal(JSON.parse(describeApprovedPlan(stored(1, planFromReply({ summary: "s", expectedBehaviour: ["a"] }, "t"), "h"), undefined)).requirements, undefined, "a plan without any keeps its old shape");
  assert.equal(numberedRequirements(["a", "b"]), "1. a\n2. b");
  assert.match(numberedRequirements([]), /^None/);
});

// Dynamic-csv PRs #20, #23, #27: 7 of 7 rejections held a round to the first plan's example, which the review had replaced.
test("a follow-up round gets the first change's plan under firstChange, so none of its examples or requirements is the round's target", () => {
  const plan = stored(1, { ...planFromReply({ summary: "Name the file.", expectedBehaviour: ["old message"], filesToEdit: ["f"] }, "t"), requirements: ["Keep the old message"] }, "h");
  const round = JSON.parse(describeApprovedPlan(plan, undefined, true));
  assert.deepEqual(Object.keys(round), ["firstChange"]);
  assert.deepEqual(round.firstChange.expectedBehaviour, ["old message"]);
  assert.deepEqual(round.firstChange.requirements, ["1. Keep the old message"]);
  assert.deepEqual(JSON.parse(describeApprovedPlan(plan, undefined)).expectedBehaviour, ["old message"], "a first change keeps its plan at the top level");
});
