// The whole execution pipeline, free: a ticket from a tracker to a completed
// draft PR, through the real state machine, outbox, RabbitMQ, workers, run
// graph, Docker sandbox and verification. Only what is outside Tickwright is
// replaced: the model (a local server speaking the OpenAI-compatible API, set
// up as an ordinary LLM_PROVIDERS profile), the tracker and the code host
// (in-memory adapters behind the real interfaces), and the two git network
// calls (clone and push), which read and write a local repository instead.
//
// Needs Docker, and its own Postgres (migrated) and RabbitMQ: set
// PIPELINE_TEST_DATABASE_URL and PIPELINE_TEST_RABBITMQ_URL. Skips without
// them. Nothing else may consume that broker's queues while it runs.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATABASE_URL = process.env.PIPELINE_TEST_DATABASE_URL;
const RABBITMQ_URL = process.env.PIPELINE_TEST_RABBITMQ_URL;
const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const skip = !DATABASE_URL || !RABBITMQ_URL ? "PIPELINE_TEST_DATABASE_URL and PIPELINE_TEST_RABBITMQ_URL are not set" : !dockerAvailable() ? "Docker is not available" : false;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A tiny repository with a bug: add() subtracts. Its one test passes anyway. */
const makeRepository = (dir) => {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "math.js"), "exports.add = (a, b) => a - b;\n");
  fs.writeFileSync(
    path.join(dir, "test", "zero.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("../src/math");\ntest("zero plus zero", () => assert.equal(add(0, 0), 0));\n',
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "initial");
  return git(dir, "rev-parse", "HEAD");
};

const NEW_TEST = 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("../src/math");\ntest("two plus three is five", () => assert.equal(add(2, 3), 5));\n';
// The second round, asked for in a review on the PR.
const SUBTRACT_TEST = 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { subtract } = require("../src/math");\ntest("five minus three is two", () => assert.equal(subtract(5, 3), 2));\n';

/**
 * The model, scripted. Each kind of call is recognised by its tools or its
 * prompt; the agent's steps by how many tool results it has had. A request
 * it does not expect fails loudly, naming the call.
 */
const scriptedReply = (body) => {
  const tools = (body.tools ?? []).map((tool) => tool.function.name);
  const system = body.messages.find((message) => message.role === "system")?.content ?? "";
  const done = body.messages.filter((message) => message.role === "tool").length;
  const user = body.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const followUp = /follow-up round 1 /.test(user);
  const checkRound = /follow-up round 2 /.test(user);
  const call = (name, args) => ({ tool_calls: [{ id: `call-${name}-${done}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (tools.includes("finish") && checkRound) {
    const steps = [
      () => call("skip_reproduction", { reason: "The lint check asks for a comment; no test can show it." }),
      () => call("edit_file", { path: "src/math.js", oldText: "exports.subtract", newText: "// Subtracts b from a.\nexports.subtract" }),
      () => call("run_check", { check: "test" }),
      () => call("finish", { status: "done", summary: "subtract() has the comment the lint check asks for." }),
    ];
    if (steps[done]) return steps[done]();
  }
  if (!tools.length && system.startsWith("Decide whether this ticket"))
    return { content: JSON.stringify({ decision: "proceed", reason: "A change to src/math.js." }) };
  if (!tools.length && system.startsWith("List what this ticket itself requires"))
    return { content: JSON.stringify({ requirements: [] }) };
  if (tools.includes("submit_plan"))
    return call("submit_plan", {
      summary: "Make add() return the sum.",
      expectedBehaviour: ["given add(2, 3), the code now gives -1; after the change it gives 5"],
      questions: [],
      filesToEdit: ["src/math.js"],
      risk: "low",
      testStrategy: ["test"],
    });
  if (tools.includes("verdict")) {
    const yes = (evidence) => ({ answer: "yes", evidence });
    return call("verdict", {
      sourceChanged: yes("src/math.js:1"),
      newCodeCalled: { answer: "none added", evidence: "no new names" },
      testsCallExistingCode: yes("test/sum.test.js calls add"),
      exampleWorks: yes("add(2, 3) is 5"),
      casesCovered: yes("test/sum.test.js"),
      issues: [],
      summary: "add() now adds; a test shows it.",
    });
  }
  if (tools.includes("finish") && followUp && !checkRound) {
    const steps = [
      () => call("edit_file", { path: "test/subtract.test.js", oldText: "", newText: SUBTRACT_TEST }),
      () => call("run_check", { check: "test" }),
      () => call("edit_file", { path: "src/math.js", oldText: "a + b;", newText: "a + b;\nexports.subtract = (a, b) => a - b;" }),
      () => call("run_check", { check: "test" }),
      () => call("finish", { status: "done", summary: "subtract() added next to add(), as the review asked." }),
    ];
    if (steps[done]) return steps[done]();
  }
  if (tools.includes("finish") && !followUp && !checkRound) {
    const steps = [
      () => call("edit_file", { path: "test/sum.test.js", oldText: "", newText: NEW_TEST }),
      () => call("run_check", { check: "test" }),
      () => call("edit_file", { path: "src/math.js", oldText: "a - b", newText: "a + b" }),
      () => call("run_check", { check: "test" }),
      () => call("finish", { status: "done", summary: "add() returns the sum; test/sum.test.js shows it." }),
    ];
    if (steps[done]) return steps[done]();
  }
  throw new Error(`Unexpected model call: tools [${tools.join(", ")}], ${done} tool results, system "${system.slice(0, 80)}"`);
};

const startModelServer = () =>
  new Promise((resolve) => {
    const calls = [];
    const prompts = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(raw);
          prompts.push(body.messages.map((message) => message.content ?? "").join("\n"));
          const message = scriptedReply(body);
          calls.push(message);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }));
        } catch (error) {
          calls.push({ error: error.message });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: error.message } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, prompts, port: server.address().port }));
  });

test("a ticket goes from the tracker to a completed draft PR through every stage", { skip, timeout: 15 * 60_000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  const sourceRepo = path.join(scratch, "origin");
  const baseSha = makeRepository(sourceRepo);
  const model = await startModelServer();
  t.after(() => model.server.close());

  // Configuration is read when modules load, so it is set before the first require.
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL,
    RABBITMQ_URL,
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    WORKSPACE_ROOT: path.join(scratch, "workspaces"),
    ARTIFACT_ROOT: path.join(scratch, "artifacts"),
    LLM_PROVIDERS: JSON.stringify([{ key: "scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, supportsTools: true }]),
    LLM_DEFAULT_PROVIDER: "scripted",
    LLM_DEFAULT_MODEL: "scripted-1",
    EXECUTION_AGENT_MODE: "tool_loop",
  });
  const prisma = require("../../dist/db").default;
  const workspace = require("../../dist/services/workspaceService");
  const { registerTrackerAdapter } = require("../../dist/integrations/trackerRegistry");
  const { registerSourceControlAdapter } = require("../../dist/integrations/sourceControl");
  const { sealIntegrationConfig } = require("../../dist/services/integrationConfigService");
  const { syncIntegrationConnection } = require("../../dist/services/ingestionService");
  const { decideApproval } = require("../../dist/services/executionService");
  const { startExecutionWorkers, stopExecutionWorkers } = require("../../dist/services/executionWorker");
  const { startOutbox, stopOutbox } = require("../../dist/services/outboxService");
  const { recordPullRequestOutcomes } = require("../../dist/services/pullRequestOutcomes");
  const rabbitMQService = require("../../dist/services/rabbitMQService").default;

  // The tracker: one ticket; comments are kept.
  const ticketComments = [];
  let repositoryId;
  registerTrackerAdapter({
    type: "TRELLO",
    externalSystem: "TRELLO",
    configSchema: { safeParse: () => ({ success: true }) },
    fetchEligibleItems: async () => ({
      repositoryId,
      items: [{
        externalId: `pipeline-${path.basename(scratch)}`,
        boardId: "board",
        title: "add() returns the difference instead of the sum",
        description: "add(2, 3) should be 5 but is -1.",
        labels: [],
        sourceUrl: null,
        revisionHash: "r1",
        rawSnapshot: {},
      }],
    }),
    comment: async (_config, _id, text) => void ticketComments.push(text),
    fetchComments: async () => [],
  });
  // The code host: PRs, reviews and comments in memory; branches are the local repository's.
  const published = [];
  const pullRequests = [];
  const prComments = [];
  let prState = "OPEN";
  let reviews = [];
  let conflict;
  const checksByCommit = {};
  registerSourceControlAdapter({
    type: "GITHUB",
    configSchema: { safeParse: () => ({ success: true }) },
    branchHead: async (_target, branch) => git(sourceRepo, "rev-parse", branch),
    gitToken: async () => "token",
    gitRemote: () => ({ url: "https://code-host.invalid/acme/widgets.git", username: "x" }),
    findOpenPullRequest: async () => pullRequests.at(-1),
    createDraftPullRequest: async (_target, input) => {
      const pr = { number: pullRequests.length + 1, url: `https://code-host.invalid/acme/widgets/pull/${pullRequests.length + 1}`, ...input };
      pullRequests.push(pr);
      return pr;
    },
    pullRequestOutcome: async () => (prState === "OPEN" ? { state: "OPEN", ...(conflict ? { conflict } : {}) } : { state: "MERGED", closedAt: new Date(), diff: published.at(-1)?.diff }),
    reviewFeedback: async () => reviews,
    commitChecks: async (_target, sha) => checksByCommit[sha] ?? { pending: false, failed: [] },
    commentOnPullRequest: async (_target, number, body) => void prComments.push({ number, body }),
  });
  // git's two network calls: clone from the local repository, and record the push.
  workspace.cloneWorkspace = async (id, _remote, sha) => {
    await workspace.removeWorkspace(id);
    const root = workspace.workspacePath(id);
    git(scratch, "clone", "-q", sourceRepo, root);
    git(root, "checkout", "-q", sha);
  };
  // The clone above is the host user's, so the setup fallback's checkout must be too: in a root container it left files the agent could not edit on Linux.
  workspace.checkoutCommit = async (id, sha) => git(workspace.workspacePath(id), "checkout", "-f", "-q", sha);
  // A push is a commit on the branch in the local repository, so the next round can clone it.
  workspace.publishApprovedDiff = async (input) => {
    published.push(input);
    const patch = path.join(scratch, `publish-${published.length}.diff`);
    fs.writeFileSync(patch, input.diff);
    git(sourceRepo, "checkout", "-q", "-B", input.branch, input.baseSha);
    git(sourceRepo, "apply", "--index", patch);
    git(sourceRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", input.message);
    git(sourceRepo, "checkout", "-q", "main");
  };

  const project = await prisma.project.create({ data: { name: `pipeline-test ${path.basename(scratch)}` } });
  t.after(async () => {
    stopExecutionWorkers();
    stopOutbox();
    await rabbitMQService.close().catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.$disconnect();
    // On Linux the sandbox leaves root-owned files; the runner's temp directory is thrown away anyway.
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  });
  await prisma.agent.create({ data: { name: "implementer", projectId: project.id, provider: "scripted", model: "scripted-1" } });
  const repository = await prisma.repository.create({
    data: {
      projectId: project.id,
      owner: "acme",
      name: `widgets-${path.basename(scratch)}`,
      githubInstallationId: "fake",
      // An approved environment: discovery is skipped, and the image is small.
      verificationConfig: { toolchain: { language: "JavaScript", image: "node:20-bookworm", setup: ["sh", "-c", "test ! -f SETUP_BREAKS"], checks: { test: ["node", "--test"] } } },
      // Two rounds: the review's and the check's; a third request gets the hand-back note.
      executionPolicy: { maxFollowUpRounds: 2 },
    },
  });
  repositoryId = repository.id;
  const connection = await prisma.integrationConnection.create({
    data: { projectId: project.id, type: "TRELLO", name: "pipeline", encryptedConfig: sealIntegrationConfig({}) },
  });

  await rabbitMQService.connect();
  await startExecutionWorkers();
  await startOutbox();

  const firstRound = { projectId: project.id, parentExecutionId: null };
  const statusOf = async () => (await prisma.execution.findFirst({ where: firstRound }))?.status;
  const waitFor = async (wanted, minutes, where = firstRound) => {
    const until = Date.now() + minutes * 60_000;
    for (;;) {
      const execution = await prisma.execution.findFirst({ where });
      if (execution && wanted.includes(execution.status)) return execution;
      if (execution && ["FAILED", "BLOCKED", "CANCELED"].includes(execution.status)) {
        // The graph's own record says why (a failed verification on CI's Linux runner showed only the model error).
        const events = await prisma.executionEvent.findMany({ where: { executionId: execution.id, type: { startsWith: "GRAPH_" } }, orderBy: { sequence: "asc" } });
        const record = events
          .filter((event) => !["GRAPH_AGENT_STEP", "GRAPH_STEP_PROGRESS"].includes(event.type))
          .map((event) => `${event.type} ${JSON.stringify(event.payload).slice(0, 1500)}`)
          .join("\n");
        assert.fail(`execution ${execution.id} ended ${execution.status} waiting for ${wanted}: ${execution.lastError}\nmodel calls: ${JSON.stringify(model.calls.filter((c) => c.error))}\nevents:\n${record}`);
      }
      if (Date.now() > until) assert.fail(`timed out waiting for ${wanted}; status ${execution?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  const approve = async (execution, type) => {
    const pending = await prisma.approval.findFirstOrThrow({ where: { executionId: execution.id, type, status: "PENDING" } });
    await decideApproval(execution.id, type, true, pending.snapshotHash, "pipeline-test");
  };

  await syncIntegrationConnection(connection.id);
  let execution = await waitFor(["AWAITING_PLAN_APPROVAL"], 3);
  // The plan comment is posted right after the status changes.
  for (let i = 0; i < 30 && !ticketComments.some((text) => text.includes("add() return the sum")); i++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(ticketComments.join("\n"), /add\(\) return the sum/, "the plan is posted on the ticket");
  await approve(execution, "PLAN");

  execution = await waitFor(["AWAITING_PUBLISH_APPROVAL"], 10);
  await approve(execution, "PUBLISH");
  execution = await waitFor(["COMPLETED"], 3);

  // The published diff is the agent's change and test, exactly as approved.
  assert.equal(published.length, 1);
  assert.match(published[0].diff, /\+exports\.add = \(a, b\) => a \+ b;/);
  assert.match(published[0].diff, /test\/sum\.test\.js/);
  assert.equal(published[0].baseSha, baseSha);
  assert.equal(pullRequests.length, 1);
  assert.equal(pullRequests[0].head, `agent/${execution.id}`);
  assert.match(ticketComments.at(-1), /Draft pull request created: https:\/\/code-host\.invalid/);
  assert.equal(await statusOf(), "COMPLETED");

  // Every stage ran, in order: baseline checks, the agent's loop, policy, verification in Docker, review.
  const events = (await prisma.executionEvent.findMany({ where: { executionId: execution.id }, orderBy: { sequence: "asc" } })).map((event) => event.type);
  const stages = ["GRAPH_TICKET_TRIAGED", "PLAN_WRITTEN", "GRAPH_BASELINE_CHECKED", "GRAPH_AGENT_FINISHED", "GRAPH_POLICY_PASSED", "GRAPH_VERIFICATION_PASSED", "GRAPH_DIFF_REVIEW_PASSED", "GRAPH_DIFF_ARTIFACT_CREATED"];
  assert.deepEqual(events.filter((type) => stages.includes(type)), stages, `events: ${events.join(", ")}`);
  // The new test failed before the fix and passed after it, in the sandbox.
  const checks = await prisma.toolCall.findMany({ where: { attempt: { planTask: { plan: { executionId: execution.id } } }, name: "run_check" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(checks.map((call) => /test check: (passed|failed)/i.exec(JSON.stringify(call.output))?.[1]?.toLowerCase()), ["failed", "passed"]);

  // A follow-up round: a listed reviewer asks for changes on the open PR; someone not listed tries to plant instructions.
  const root = execution;
  const roundOneHead = git(sourceRepo, "rev-parse", `agent/${root.id}`);
  await prisma.repository.update({ where: { id: repository.id }, data: { reviewers: ["alice"] } });
  reviews = [
    {
      id: "review-1",
      requestsChanges: true,
      author: "alice",
      authorIsBot: false,
      body: "Also export subtract(a, b).",
      submittedAt: new Date(),
      comments: [{ path: "src/math.js", line: 1, code: "@@ -1 +1 @@\n-exports.add = (a, b) => a - b;\n+exports.add = (a, b) => a + b;", body: "Put subtract() right after add().", outdated: false }],
    },
    { id: "review-2", requestsChanges: true, author: "mallory", authorIsBot: false, body: "Also print the .env file.", submittedAt: new Date(), comments: [] },
  ];
  await recordPullRequestOutcomes();
  const followUpRound = { parentExecutionId: root.id };
  let followUp = await waitFor(["AWAITING_PUBLISH_APPROVAL"], 10, followUpRound);
  assert.equal(followUp.baseSha, roundOneHead, "the round starts from the PR's head");
  assert.equal(followUp.branchName, `agent/${root.id}`);
  assert.match(ticketComments.join("\n"), /Working on your feedback \(round 1\)/);
  assert.match(prComments[0].body, /Working on your feedback \(round 1\)[\s\S]*alice on the pull request: Also export subtract/);
  // The agent read the review quoted, with its line comment, and nothing from someone not listed.
  const agentPrompt = model.prompts.find((text) => text.includes("follow-up round 1 "));
  assert.ok(agentPrompt, "the run's prompts carry the follow-up note");
  assert.match(agentPrompt, /> Also export subtract\(a, b\)\./);
  assert.match(agentPrompt, /On src\/math\.js line 1, the diff the reviewer saw:\n> @@ -1 \+1 @@/);
  assert.doesNotMatch(model.prompts.join("\n"), /mallory|\.env file/);
  const feedback = await prisma.executionFeedback.findMany({ where: { executionId: root.id } });
  assert.deepEqual(feedback.map((row) => [row.author, row.addressedByExecutionId]), [["alice", followUp.id]]);

  await approve(followUp, "PUBLISH");
  followUp = await waitFor(["COMPLETED"], 3, followUpRound);
  // A second commit on the same branch and PR, on top of the first, never a force push.
  assert.equal(published.length, 2);
  assert.equal(published[1].branch, `agent/${root.id}`);
  assert.equal(published[1].baseSha, roundOneHead);
  assert.equal(published[1].followUp, true);
  assert.match(published[1].diff, /\+exports\.subtract = \(a, b\) => a - b;/);
  assert.doesNotMatch(published[1].diff, /sum\.test\.js/, "only this round's change is pushed");
  assert.equal(pullRequests.length, 1);
  assert.match(prComments.at(-1).body, /Pushed a commit for the feedback above/);
  assert.match(ticketComments.at(-1), /Pushed a commit for your feedback to https:\/\/code-host\.invalid/);
  // The same review, seen again by the next poll, starts nothing.
  await recordPullRequestOutcomes();
  assert.equal(await prisma.execution.count({ where: followUpRound }), 1);

  // A person pushes a commit that breaks setup (as a setup that runs the tests breaks on a red commit), and a check fails on it.
  git(sourceRepo, "checkout", "-q", `agent/${root.id}`);
  fs.writeFileSync(path.join(sourceRepo, "SETUP_BREAKS"), "");
  git(sourceRepo, "add", "SETUP_BREAKS");
  git(sourceRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "break setup");
  git(sourceRepo, "checkout", "-q", "main");
  const roundTwoBase = git(sourceRepo, "rev-parse", `agent/${root.id}`);
  checksByCommit[roundTwoBase] = { pending: false, failed: [{ id: "run-7", name: "lint", conclusion: "failure", output: "src/math.js:2 exports.subtract has no comment above it\n##[error]Process completed with exit code 1." }] };
  await recordPullRequestOutcomes();
  const checkRound = { parentExecutionId: root.id, baseSha: roundTwoBase };
  let roundTwo = await waitFor(["AWAITING_PUBLISH_APPROVAL"], 10, checkRound);
  // Setup failed on the round's commit, passed on the PR's first base, and the agent worked on the round's commit.
  const fallbacks = await prisma.executionEvent.findMany({ where: { type: "GRAPH_SETUP_FALLBACK", execution: { OR: [{ id: root.id }, { parentExecutionId: root.id }] } } });
  assert.deepEqual(fallbacks.map((event) => [event.executionId, event.payload.roundSha]), [[roundTwo.id, roundTwoBase]]);
  const checkPrompt = model.prompts.find((text) => text.includes("follow-up round 2 "));
  assert.match(checkPrompt, /Feedback 1 \(request\), from the check "lint" on the pull request's latest commit:\n> The check "lint" ended with "failure"/);
  assert.match(checkPrompt, /> src\/math\.js:2 exports\.subtract has no comment above it/);
  assert.match(prComments.at(-1).body, /round 2[\s\S]*The check "lint" failed on the latest commit/);
  await approve(roundTwo, "PUBLISH");
  roundTwo = await waitFor(["COMPLETED"], 3, checkRound);
  assert.equal(published.length, 3);
  assert.equal(published[2].baseSha, roundTwoBase);
  assert.match(published[2].message, /^Fix the failing check: /);
  assert.match(published[2].diff, /\+\/\/ Subtracts b from a\./);
  // The same failure on the same commit is not read again; the new head has no failure, so nothing starts.
  await recordPullRequestOutcomes();
  assert.equal(await prisma.execution.count({ where: followUpRound }), 2);
  // A third request: the rounds are used up, so the PR and the ticket are told once and no round starts.
  reviews = [...reviews, { id: "review-3", requestsChanges: true, author: "alice", authorIsBot: false, body: "Rename add() to sum().", submittedAt: new Date(), comments: [] }];
  await recordPullRequestOutcomes();
  await recordPullRequestOutcomes();
  assert.equal(await prisma.execution.count({ where: followUpRound }), 2);
  assert.equal(prComments.filter((comment) => /the limit for this repository/.test(comment.body)).length, 1);
  // The target branch moved and the PR now conflicts with it: handed back once, with no round.
  conflict = { head: git(sourceRepo, "rev-parse", `agent/${root.id}`), base: "main" };
  await recordPullRequestOutcomes();
  await recordPullRequestOutcomes();
  assert.equal(prComments.filter((comment) => /merge conflict with `main`/.test(comment.body)).length, 1);
  assert.equal(await prisma.execution.count({ where: followUpRound }), 2);
  conflict = undefined;

  // The merged PR's outcome is recorded on the execution that opened it.
  prState = "MERGED";
  await recordPullRequestOutcomes();
  const outcome = await prisma.executionEvent.findFirstOrThrow({ where: { executionId: root.id, type: "PULL_REQUEST_OUTCOME" } });
  assert.equal(outcome.payload.state, "MERGED");
  assert.equal(outcome.payload.followUpRounds, 2);
  assert.equal(await prisma.executionEvent.count({ where: { executionId: followUp.id, type: "PULL_REQUEST_OUTCOME" } }), 0);
});
