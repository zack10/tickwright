const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AGENT_SIGNATURE,
  formatPlanComment,
  formatPublishComment,
  isAgentComment,
  isApprover,
  replyAction,
  signed,
} = require("../dist/services/ticketConversation");
const { toComments } = require("../dist/integrations/trelloAdapter");

const reply = (text, author = "zack") => ({ id: "c1", authorId: `id-${author}`, authorName: author, text, createdAt: new Date() });
const approvers = ["@Zack"];

test("only an approver's /approve approves", () => {
  assert.deepEqual(replyAction(reply("/approve"), approvers, "PLAN"), { kind: "approve", note: undefined });
  assert.deepEqual(replyAction(reply("/APPROVE keep the log line"), approvers, "PUBLISH"), { kind: "approve", note: "keep the log line" });
  assert.deepEqual(replyAction(reply("/reject not now"), approvers, "PLAN"), { kind: "reject", reason: "not now" });
  assert.equal(replyAction(reply("/approve", "mallory"), approvers, "PLAN").kind, "unauthorized");
  assert.equal(replyAction(reply("looks good, approve"), approvers, "PLAN").kind, "revise", "free text never approves");
  assert.equal(replyAction(reply("/approved"), approvers, "PLAN").kind, "hint", "a command is a whole word; a near miss gets a hint");
});

test("on a plan other text is feedback; on a change it gets a hint", () => {
  assert.deepEqual(replyAction(reply("No, wait until Tuesday 02:00"), approvers, "PLAN"), {
    kind: "revise",
    feedback: "No, wait until Tuesday 02:00",
  });
  assert.equal(replyAction(reply("hmm"), approvers, "PUBLISH").kind, "hint");
  assert.equal(replyAction(reply("/aprove"), approvers, "PLAN").kind, "hint", "a mistyped command does not cost a revision");
  assert.equal(replyAction(reply("/api/users should return 404"), approvers, "PLAN").kind, "revise", "a path is feedback");
});

test("the agent's own comments and empty ones are never replies", () => {
  // Locally the agent posts with the person's token, so the author is an approver.
  assert.equal(replyAction(reply(signed("/approve")), approvers, "PLAN").kind, "ignore");
  assert.equal(replyAction(reply("   "), approvers, "PLAN").kind, "ignore");
  assert.ok(isAgentComment(`plan\n\n${AGENT_SIGNATURE}\n`));
  assert.ok(!isAgentComment(`About "${AGENT_SIGNATURE}" above: wait until Tuesday`), "only a signature at the end counts");
});

test("approvers match by tracker id or name, without @ and case", () => {
  assert.ok(isApprover({ authorId: "5f1", authorName: "someone" }, ["5F1"]));
  assert.ok(isApprover({ authorId: "x", authorName: "Zack" }, ["@zack"]));
  assert.ok(!isApprover({ authorId: "x", authorName: "zackary" }, ["zack"]));
});

test("the plan comment shows the reading, the doubts and how to answer", () => {
  const text = formatPlanComment(
    {
      summary: "Skip missed nights.",
      expectedBehaviour: ["back Monday 09:00 -> next run Tuesday 02:00"],
      questions: ["if you meant one catch-up run: Monday 09:00"],
      filesToEdit: ["schedule/schedule.go"],
      risk: "low",
      testStrategy: ["go test ./...", "new test for missed runs"],
    },
    2,
  );
  assert.match(text, /\*\*Plan \(version 2\):\*\* Skip missed nights\./);
  assert.match(text, /- back Monday 09:00 -> next run Tuesday 02:00/);
  assert.match(text, /not sure[\s\S]*- if you meant one catch-up run/);
  assert.match(text, /How I'll check it:\*\*\n- go test \.\/\.\.\.\n- new test for missed runs/);
  assert.match(text, /`\/approve`[\s\S]*`\/reject <reason>`[\s\S]*revise the plan/);
  assert.doesNotMatch(formatPlanComment({ summary: "s", expectedBehaviour: [], questions: [], filesToEdit: [], risk: "low", testStrategy: [] }, 1), /not sure|version/);
  const bare = { summary: "s", expectedBehaviour: [], questions: [], filesToEdit: [], risk: "low", testStrategy: [] };
  assert.doesNotMatch(formatPlanComment(bare, 1, "checks"), /Unverified|No checks/);
  assert.match(formatPlanComment(bare, 1, "none"), /\*\*Unverified:\*\*[^\n]*nothing will test the change[\s\S]*`\/approve`/);
  assert.match(formatPlanComment(bare, 1, "discovery"), /No checks are set for this repository yet/);
  assert.match(formatPublishComment(["a.go"], "Checks passed: test."), /Changed:\*\* a\.go[\s\S]*Checks passed[\s\S]*draft pull request/);
});

test("Trello comment actions become comments, oldest first", () => {
  const comments = toComments([
    { id: "2", date: "2026-11-01T10:05:00.000Z", idMemberCreator: "m1", memberCreator: { username: "zack" }, data: { text: "/approve" } },
    { id: "1", date: "2026-11-01T10:00:00.000Z", idMemberCreator: "m2", data: {} },
  ]);
  assert.deepEqual(comments.map((comment) => comment.id), ["1", "2"]);
  assert.equal(comments[0].authorName, "m2", "falls back to the member id");
  assert.equal(comments[0].text, "");
  assert.equal(comments[1].authorName, "zack");
});
