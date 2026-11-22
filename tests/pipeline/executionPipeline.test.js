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

/**
 * The model, scripted. Each kind of call is recognised by its tools or its
 * prompt; the agent's steps by how many tool results it has had. A request
 * it does not expect fails loudly, naming the call.
 */
const scriptedReply = (body) => {
  const tools = (body.tools ?? []).map((tool) => tool.function.name);
  const system = body.messages.find((message) => message.role === "system")?.content ?? "";
  const done = body.messages.filter((message) => message.role === "tool").length;
  const call = (name, args) => ({ tool_calls: [{ id: `call-${name}-${done}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
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
  if (tools.includes("finish")) {
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
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          const message = scriptedReply(JSON.parse(raw));
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
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port }));
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
  // The code host: branch heads and PRs in memory.
  const published = [];
  const pullRequests = [];
  registerSourceControlAdapter({
    type: "GITHUB",
    configSchema: { safeParse: () => ({ success: true }) },
    branchHead: async () => baseSha,
    gitToken: async () => "token",
    gitRemote: () => ({ url: "https://code-host.invalid/acme/widgets.git", username: "x" }),
    findOpenPullRequest: async () => pullRequests.at(-1),
    createDraftPullRequest: async (_target, input) => {
      const pr = { number: pullRequests.length + 1, url: `https://code-host.invalid/acme/widgets/pull/${pullRequests.length + 1}`, ...input };
      pullRequests.push(pr);
      return pr;
    },
    pullRequestOutcome: async () => ({ state: "MERGED", closedAt: new Date(), diff: published.at(-1)?.diff }),
  });
  // git's two network calls: clone from the local repository, and record the push.
  workspace.cloneWorkspace = async (id, _remote, sha) => {
    await workspace.removeWorkspace(id);
    const root = workspace.workspacePath(id);
    git(scratch, "clone", "-q", sourceRepo, root);
    git(root, "checkout", "-q", sha);
  };
  workspace.publishApprovedDiff = async (input) => void published.push(input);

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
      verificationConfig: { toolchain: { language: "JavaScript", image: "node:20-bookworm", setup: null, checks: { test: ["node", "--test"] } } },
      executionPolicy: {},
    },
  });
  repositoryId = repository.id;
  const connection = await prisma.integrationConnection.create({
    data: { projectId: project.id, type: "TRELLO", name: "pipeline", encryptedConfig: sealIntegrationConfig({}) },
  });

  await rabbitMQService.connect();
  await startExecutionWorkers();
  await startOutbox();

  const statusOf = async () => (await prisma.execution.findFirst({ where: { projectId: project.id } }))?.status;
  const waitFor = async (wanted, minutes) => {
    const until = Date.now() + minutes * 60_000;
    for (;;) {
      const execution = await prisma.execution.findFirst({ where: { projectId: project.id } });
      if (execution && wanted.includes(execution.status)) return execution;
      if (execution && ["FAILED", "BLOCKED", "CANCELED"].includes(execution.status))
        assert.fail(`execution ended ${execution.status} waiting for ${wanted}: ${execution.lastError}\nmodel calls: ${JSON.stringify(model.calls.filter((c) => c.error))}`);
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

  // Step 2: the merged PR's outcome is recorded.
  await recordPullRequestOutcomes();
  const outcome = await prisma.executionEvent.findFirstOrThrow({ where: { executionId: execution.id, type: "PULL_REQUEST_OUTCOME" } });
  assert.equal(outcome.payload.state, "MERGED");
  assert.equal(outcome.payload.mergedAsWritten, true);
});
