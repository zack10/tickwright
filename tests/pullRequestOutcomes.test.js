const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-outcomes-"));
process.env.ARTIFACT_ROOT = artifactRoot;
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GITHUB_APP_ID = "1";
process.env.GITHUB_APP_PRIVATE_KEY = require("node:crypto")
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });
const axios = require("axios");
const prisma = require("../dist/db").default;
const { getPullRequestOutcome } = require("../dist/integrations/githubApp");
const { registerSourceControlAdapter } = require("../dist/integrations/sourceControl");
const { filesChangedByPerson, recordPullRequestOutcomes } = require("../dist/services/pullRequestOutcomes");

// The agent's diff, and the same change as a host renders it: other index lines, hunk header and context.
const published = [
  "diff --git a/src/math.js b/src/math.js",
  "index 1111111..2222222 100644",
  "--- a/src/math.js",
  "+++ b/src/math.js",
  "@@ -1,3 +1,3 @@",
  " function add(a, b) {",
  "-  return a - b;",
  "+  return a + b;",
  " }",
  "",
].join("\n");
const rendered = published.replace("index 1111111..2222222", "index 1111111abc..2222222def").replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,3 @@ module");

test("the same change rendered by another tool is merged as written", () => {
  assert.deepEqual(filesChangedByPerson(published, rendered), []);
  assert.deepEqual(filesChangedByPerson(published, rendered.replaceAll("\n", "\r\n")), []);
});

test("a file the person edited or added is listed as changed by the person", () => {
  const edited = rendered.replace("+  return a + b;", "+  return b + a;");
  const added = `${rendered}diff --git a/test/math.test.js b/test/math.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/test/math.test.js\n@@ -0,0 +1 @@\n+test();\n`;
  assert.deepEqual(filesChangedByPerson(published, edited), ["src/math.js"]);
  assert.deepEqual(filesChangedByPerson(published, added), ["test/math.test.js"]);
  assert.deepEqual(filesChangedByPerson(published, ""), ["src/math.js"]);
});

test("a binary file counts as unchanged however each tool renders it", () => {
  const ours = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nGIT binary patch\nliteral 10\nabcdef\n";
  const host = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
  assert.deepEqual(filesChangedByPerson(ours, host), []);
});

// A host whose pull requests are scripted per number.
const outcomes = new Map();
registerSourceControlAdapter({
  type: "TEST_HOST",
  configSchema: { safeParse: () => ({ success: true }) },
  pullRequestOutcome: async (_target, number) => outcomes.get(number),
});

const stubDatabase = (t, executions) => {
  const saved = { artifacts: [], events: [] };
  const real = { execution: prisma.execution, $transaction: prisma.$transaction };
  const tx = {
    artifact: { create: async ({ data }) => saved.artifacts.push(data) },
    executionEvent: {
      findFirst: async () => ({ sequence: 4 }),
      create: async ({ data }) => saved.events.push(data),
    },
  };
  // The follow-up query (it filters on feedback) finds nothing here; followUps.test.js covers it.
  prisma.execution = { findMany: async (args) => (args.where.feedback ? [] : executions) };
  prisma.$transaction = async (fn) => fn(tx);
  t.after(() => Object.assign(prisma, real));
  return saved;
};

const execution = (id, number, followUpRounds = 0) => {
  const diffPath = path.join(artifactRoot, `${id}.diff`);
  fs.writeFileSync(diffPath, published);
  return {
    id,
    correlationId: `corr-${id}`,
    repository: { id: "r", provider: "TEST_HOST", owner: "acme", name: "widgets", connectionId: null },
    artifacts: [
      { type: "PULL_REQUEST", metadata: { number, html_url: `https://host/pr/${number}` } },
      { type: "DIFF", storagePath: diffPath },
    ],
    _count: { followUps: followUpRounds },
  };
};

test("after follow-up commits the merged PR is recorded, but not compared with one round's diff", async (t) => {
  outcomes.set(6, { state: "MERGED", closedAt: new Date("2026-11-22T10:00:00Z"), diff: rendered });
  const saved = stubDatabase(t, [execution("e6", 6, 1)]);
  await recordPullRequestOutcomes();
  const [{ payload }] = saved.events;
  assert.equal(payload.state, "MERGED");
  assert.equal(payload.mergedAsWritten, null);
  assert.equal(payload.followUpRounds, 1);
});

test("a merged pull request records whether it was merged as written, and keeps the merged diff", async (t) => {
  outcomes.set(1, { state: "MERGED", closedAt: new Date("2026-11-20T10:00:00Z"), diff: rendered });
  outcomes.set(2, { state: "MERGED", closedAt: new Date("2026-11-21T10:00:00Z"), diff: rendered.replace("a + b", "b + a") });
  const saved = stubDatabase(t, [execution("e1", 1), execution("e2", 2)]);
  await recordPullRequestOutcomes();
  assert.deepEqual(saved.events.map((event) => [event.executionId, event.type, event.sequence, event.payload.mergedAsWritten]), [
    ["e1", "PULL_REQUEST_OUTCOME", 5, true],
    ["e2", "PULL_REQUEST_OUTCOME", 5, false],
  ]);
  assert.deepEqual(saved.events[1].payload.filesChangedByPerson, ["src/math.js"]);
  assert.equal(saved.artifacts.length, 2);
  assert.equal(saved.artifacts[1].type, "MERGED_DIFF");
  assert.equal(fs.readFileSync(saved.artifacts[1].storagePath, "utf8"), outcomes.get(2).diff);
});

test("an open pull request records nothing; a closed one records that it was not merged", async (t) => {
  outcomes.set(3, { state: "OPEN" });
  outcomes.set(4, { state: "CLOSED", closedAt: new Date("2026-11-21T10:00:00Z") });
  const saved = stubDatabase(t, [execution("e3", 3), execution("e4", 4)]);
  await recordPullRequestOutcomes();
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].executionId, "e4");
  assert.equal(saved.events[0].payload.state, "CLOSED");
  assert.equal(saved.events[0].payload.mergedAsWritten, false);
  assert.equal(saved.artifacts.length, 0);
});

test("a merged pull request whose diff the host cannot give is recorded as merged, as written unknown", async (t) => {
  outcomes.set(5, { state: "MERGED", closedAt: new Date() });
  const saved = stubDatabase(t, [execution("e5", 5)]);
  await recordPullRequestOutcomes();
  assert.equal(saved.events[0].payload.mergedAsWritten, null);
  assert.equal(saved.artifacts.length, 0);
});

test("one pull request that cannot be read does not stop the others", async (t) => {
  outcomes.set(6, undefined); // the adapter returns nothing usable: reading .state throws
  outcomes.set(7, { state: "CLOSED", closedAt: new Date() });
  const saved = stubDatabase(t, [execution("e6", 6), execution("e7", 7)]);
  t.mock.method(console, "error", () => {});
  await recordPullRequestOutcomes();
  assert.deepEqual(saved.events.map((event) => event.executionId), ["e7"]);
});

test("GitHub reports open, closed and merged pull requests, and a merge too large to diff", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { token: "t" } }));
  const replies = [];
  t.mock.method(axios, "get", async (_url, options) => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (options.headers.Accept === "application/vnd.github.diff") assert.equal(options.responseType, "text");
    return { data: reply };
  });
  replies.push({ state: "open", merged_at: null, closed_at: null });
  assert.deepEqual(await getPullRequestOutcome("i", "acme", "widgets", 1), { state: "OPEN" });
  replies.push({ state: "closed", merged_at: null, closed_at: "2026-11-21T10:00:00Z" });
  assert.deepEqual(await getPullRequestOutcome("i", "acme", "widgets", 1), { state: "CLOSED", closedAt: new Date("2026-11-21T10:00:00Z") });
  replies.push({ state: "closed", merged_at: "2026-11-21T11:00:00Z", closed_at: "2026-11-21T11:00:00Z" }, "diff text");
  assert.deepEqual(await getPullRequestOutcome("i", "acme", "widgets", 1), { state: "MERGED", closedAt: new Date("2026-11-21T11:00:00Z"), diff: "diff text" });
  const tooLarge = Object.assign(new Error("Not Acceptable"), { isAxiosError: true, response: { status: 406 } });
  replies.push({ state: "closed", merged_at: "2026-11-21T11:00:00Z", closed_at: null }, tooLarge);
  assert.deepEqual(await getPullRequestOutcome("i", "acme", "widgets", 1), { state: "MERGED", closedAt: new Date("2026-11-21T11:00:00Z") });
});
