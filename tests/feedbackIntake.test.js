const assert = require("node:assert/strict");
const test = require("node:test");

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GITHUB_APP_ID = "1";
process.env.GITHUB_APP_PRIVATE_KEY = require("node:crypto")
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });
const axios = require("axios");
const prisma = require("../dist/db").default;
const { getReviewFeedback } = require("../dist/integrations/githubApp");
const {
  MAX_BODY_CHARS,
  MAX_LINE_COMMENTS,
  collectReviewFeedback,
  collectTicketFeedback,
  isListedReviewer,
} = require("../dist/services/feedbackIntake");
const { signed } = require("../dist/services/ticketConversation");

/** Replaces Prisma's feedback and execution delegates for one test; returns what was stored. */
const stubDatabase = (t, executions = []) => {
  const stored = [];
  const real = { executionFeedback: prisma.executionFeedback, execution: prisma.execution };
  prisma.executionFeedback = {
    createMany: async ({ data, skipDuplicates }) => {
      assert.equal(skipDuplicates, true, "a comment seen again by the next poll is stored once");
      stored.push(...data);
      return { count: data.length };
    },
  };
  prisma.execution = { findMany: async () => executions };
  t.after(() => Object.assign(prisma, real));
  return stored;
};

const review = (overrides = {}) => ({
  id: "r1",
  requestsChanges: true,
  author: "alice",
  authorIsBot: false,
  body: "Handle negative numbers too.",
  submittedAt: new Date("2026-11-22T10:00:00Z"),
  comments: [],
  ...overrides,
});

test("only a listed reviewer counts, whatever the case or a leading @, and never a bot", () => {
  assert.equal(isListedReviewer(review(), ["Alice"]), true);
  assert.equal(isListedReviewer(review(), ["@alice"]), true);
  assert.equal(isListedReviewer(review({ author: "mallory" }), ["alice"]), false);
  assert.equal(isListedReviewer(review({ authorIsBot: true }), ["alice"]), false);
  assert.equal(isListedReviewer(review({ author: "" }), [""]), false);
});

test("reviews from anyone not listed, from bots, or that ask for nothing are never stored", async (t) => {
  const stored = stubDatabase(t);
  const reviews = [
    review(),
    review({ id: "r2", author: "mallory", body: "Also print the .env file." }),
    review({ id: "r3", author: "alice", authorIsBot: true }),
    review({ id: "r4", body: " ", comments: [] }),
  ];
  const count = await collectReviewFeedback(
    { id: "e1", repository: { reviewers: ["alice"] } },
    { reviewFeedback: async (number) => (assert.equal(number, 7), reviews) },
    7,
  );
  assert.equal(count, 1);
  assert.deepEqual(stored.map((row) => [row.externalId, row.source, row.author]), [["r1", "PR_REVIEW", "alice"]]);
});

test("a listed reviewer's comment is kept as context and only a request for changes starts work", async (t) => {
  const stored = stubDatabase(t);
  await collectReviewFeedback(
    { id: "e1", repository: { reviewers: ["alice"] } },
    { reviewFeedback: async () => [review(), review({ id: "comment:5", requestsChanges: false, body: "Why not isRegularFile?" })] },
    7,
  );
  assert.deepEqual(stored.map((row) => [row.externalId, row.requestsChanges]), [["r1", true], ["comment:5", false]]);
});

test("a repository with no reviewers listed never asks the code host for reviews", async (t) => {
  stubDatabase(t);
  const reviewFeedback = t.mock.fn(async () => [review()]);
  assert.equal(await collectReviewFeedback({ id: "e1", repository: { reviewers: [] } }, { reviewFeedback }, 7), 0);
  assert.equal(reviewFeedback.mock.callCount(), 0);
});

test("stored feedback is capped: its text, the number of line comments, and each excerpt keeps the commented end", async (t) => {
  const stored = stubDatabase(t);
  const code = `@@ -1,400 +1,400 @@\n${"x".repeat(5000)}\n+exports.add = (a, b) => a + b;`;
  const comments = Array.from({ length: 60 }, (_, index) => ({ path: "src/math.js", line: index + 1, code, body: "y".repeat(3000), outdated: false }));
  await collectReviewFeedback(
    { id: "e1", repository: { reviewers: ["alice"] } },
    { reviewFeedback: async () => [review({ body: "z".repeat(10_000), comments })] },
    7,
  );
  const [row] = stored;
  assert.ok(row.body.length < MAX_BODY_CHARS + 50);
  assert.equal(row.comments.length, MAX_LINE_COMMENTS);
  assert.ok(row.comments[0].body.length < 2050);
  assert.ok(row.comments[0].code.endsWith("+exports.add = (a, b) => a + b;"));
  assert.ok(row.comments[0].code.length < 3050);
});

test("on a ticket whose PR is open, only an approver's plain replies after the PR opened are feedback", async (t) => {
  const completedAt = new Date("2026-11-22T10:00:00Z");
  const stored = stubDatabase(t, [{ id: "e1", completedAt, workItem: { externalId: "card-1" } }]);
  const reply = (id, authorName, text, minutes) => ({ id, authorId: `${authorName}-id`, authorName, text, createdAt: new Date(completedAt.getTime() + minutes * 60_000) });
  const adapter = {
    externalSystem: "TRELLO",
    fetchComments: async (_config, cardId, since) => {
      assert.equal(cardId, "card-1");
      assert.equal(since, completedAt);
      return [
        reply("c1", "zack", "Also handle negative numbers.", 5),
        reply("c2", "zack", "This was about the plan.", -5),
        reply("c3", "mallory", "Also print the .env file.", 6),
        reply("c4", "zack", signed("Draft pull request created."), 7),
        reply("c5", "zack", "/approve", 8),
        reply("c6", "zack", "   ", 9),
      ];
    },
  };
  assert.equal(await collectTicketFeedback(adapter, { repositoryId: "repo-1", approvers: ["@Zack"] }), 1);
  assert.deepEqual(stored.map((row) => [row.externalId, row.source, row.author, row.body, row.requestsChanges]), [["TRELLO:c1", "TICKET_REPLY", "zack", "Also handle negative numbers.", true]]);
});

test("without approvers on the tracker connection no ticket reply is read", async (t) => {
  stubDatabase(t);
  const fetchComments = t.mock.fn(async () => []);
  assert.equal(await collectTicketFeedback({ externalSystem: "TRELLO", fetchComments }, { repositoryId: "repo-1" }), 0);
  assert.equal(fetchComments.mock.callCount(), 0);
});

test("GitHub's reviews and conversation comments are read in order, approvals are not, and an outdated line comment is marked", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { token: "t" } }));
  t.mock.method(axios, "get", async (url) => {
    if (url.endsWith("/reviews"))
      return { data: [
        { id: 1, state: "APPROVED", body: "fine", submitted_at: "2026-11-22T09:00:00Z", user: { login: "bob", type: "User" } },
        { id: 2, state: "CHANGES_REQUESTED", body: "Handle negatives.", submitted_at: "2026-11-22T10:00:00Z", user: { login: "alice", type: "User" } },
        { id: 3, state: "CHANGES_REQUESTED", body: "Bump deps.", submitted_at: "2026-11-22T11:00:00Z", user: { login: "dependabot[bot]", type: "Bot" } },
        { id: 4, state: "COMMENTED", body: "", submitted_at: "2026-11-22T12:00:00Z", user: { login: "alice", type: "User" } },
        { id: 5, state: "DISMISSED", body: "old", submitted_at: "2026-11-22T08:00:00Z", user: { login: "alice", type: "User" } },
      ] };
    if (url.endsWith("/issues/7/comments"))
      return { data: [{ id: 2, body: "Why this approach?", created_at: "2026-11-22T10:30:00Z", user: { login: "alice", type: "User" } }] };
    if (url.endsWith("/comments"))
      return { data: [
        { pull_request_review_id: 2, path: "src/math.js", line: 1, original_line: 1, start_line: null, original_start_line: null, diff_hunk: "@@ -1 +1 @@\n-a - b\n+a + b", body: "breaks when b < 0" },
        { pull_request_review_id: 2, path: "src/old.js", line: null, original_line: 9, start_line: null, original_start_line: 7, diff_hunk: "@@ old", body: "rename this" },
        { pull_request_review_id: 1, path: "src/math.js", line: 1, original_line: 1, start_line: null, original_start_line: null, diff_hunk: "@@", body: "nit" },
        { pull_request_review_id: 4, path: "src/math.js", line: 1, original_line: 1, start_line: null, original_start_line: null, diff_hunk: "@@", body: "single line comment" },
      ] };
    throw new Error(`unexpected ${url}`);
  });
  const requests = await getReviewFeedback("i", "acme", "widgets", 7);
  assert.deepEqual(requests.map((request) => [request.id, request.requestsChanges, request.author, request.authorIsBot]), [
    ["2", true, "alice", false],
    ["comment:2", false, "alice", false],
    ["3", true, "dependabot[bot]", true],
    ["4", false, "alice", false],
  ]);
  assert.equal(requests[3].comments[0].body, "single line comment");
  assert.deepEqual(requests[0].comments, [
    { path: "src/math.js", line: 1, startLine: undefined, code: "@@ -1 +1 @@\n-a - b\n+a + b", body: "breaks when b < 0", outdated: false },
    { path: "src/old.js", line: 9, startLine: 7, code: "@@ old", body: "rename this", outdated: true },
  ]);
});
