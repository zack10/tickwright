// Execution pipeline, end to end against real services:
// Trello card -> sync -> plan -> plan approval -> Docker run + LLM -> diff ->
// publish approval -> GitHub draft PR -> Trello comment.
//
// The SERVER needs GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY, ENCRYPTION_KEY and
// Docker Desktop running. This suite needs the E2E_* variables below. Use a
// throwaway repository: a successful run pushes a branch and opens a draft PR
// (both removed in cleanup when E2E_GITHUB_TOKEN is set).
const assert = require("node:assert/strict");
const { after, before, describe } = require("node:test");

const { api, assertServerHealthy, env, envInt, poll, runId, skipUnless, steps } = require("./helpers");
const {
  PIPELINE_ENV,
  createCard,
  ensureFixtures,
  getExecution,
  github,
  ingestCard,
  pendingApproval,
  repoPath,
  trello,
  waitForStatus,
} = require("./pipeline");

const PLAN_TIMEOUT_MS = envInt("E2E_PLAN_TIMEOUT_MS", 600_000);
const RUN_TIMEOUT_MS = envInt("E2E_RUN_TIMEOUT_MS", 1_200_000);
const PUBLISH_TIMEOUT_MS = envInt("E2E_PUBLISH_TIMEOUT_MS", 300_000);

describe("execution pipeline (Trello -> GitHub draft PR)", { skip: skipUnless(PIPELINE_ENV) }, () => {
  const id = runId();
  const step = steps();
  const state = {};

  before(assertServerHealthy);

  after(async () => {
    if (env("E2E_KEEP_RESOURCES") === "true") return;
    const problems = [];
    if (state.cardId)
      await trello("DELETE", `/cards/${state.cardId}`).catch((error) => problems.push(error.message));
    if (state.branch && env("E2E_GITHUB_TOKEN")) {
      if (state.prNumber)
        await github("PATCH", `${repoPath()}/pulls/${state.prNumber}`, { state: "closed" }).catch((error) =>
          problems.push(error.message),
        );
      await github("DELETE", `${repoPath()}/git/refs/heads/${state.branch}`).catch((error) =>
        problems.push(error.message),
      );
    } else if (state.prUrl) {
      console.log(`# E2E_GITHUB_TOKEN not set: close ${state.prUrl} and delete branch ${state.branch} manually`);
    }
    if (problems.length) console.log(`# cleanup problems:\n#   ${problems.join("\n#   ")}`);
  });

  step("sets up project, agent, repository and Trello integration", async () => {
    Object.assign(state, await ensureFixtures());
  });

  step("creates a labelled Trello card", async () => {
    state.cardId = await createCard(
      `[${id}] ${env("E2E_TICKET_TITLE", "Add an end-to-end marker to the README")}`,
      env("E2E_TICKET_DESCRIPTION", `Append a single line "E2E run ${id}" to the end of README.md. Change nothing else.`),
    );
  });

  step("sync ingests the card and creates an execution", async (t) => {
    const workItem = await ingestCard(state, state.cardId);

    const { data: detail } = await api("GET", `/api/work-items/${workItem.id}`, { expectStatus: 200 });
    assert.equal(detail.executions.length, 1, "exactly one execution per card revision");
    state.executionId = detail.executions[0].id;
    t.diagnostic(`execution ${state.executionId}`);

    // Re-syncing the same revision must not create a second execution.
    await api("POST", `/api/integrations/${state.integration.id}/sync`, { expectStatus: 200 });
    const { data: again } = await api("GET", `/api/work-items/${workItem.id}`, { expectStatus: 200 });
    assert.equal(again.executions.length, 1, "re-sync created a duplicate execution");
  });

  step(
    "planner produces a plan awaiting approval",
    async () => {
      const execution = await waitForStatus(state.executionId, "AWAITING_PLAN_APPROVAL", PLAN_TIMEOUT_MS);
      state.planHash = pendingApproval(execution, "PLAN")?.snapshotHash;
      assert.match(state.planHash ?? "", /^[a-f0-9]{64}$/, "pending PLAN approval with a snapshotHash");
    },
    { timeout: PLAN_TIMEOUT_MS + 30_000 },
  );

  step("plan approval rejects a stale snapshotHash", async () => {
    await api("POST", `/api/executions/${state.executionId}/approvals/plan`, {
      body: { approved: true, snapshotHash: "0".repeat(64) },
      expectStatus: 409,
    });
  });

  step("plan approval with the current snapshotHash queues the run", async () => {
    const { data } = await api("POST", `/api/executions/${state.executionId}/approvals/plan`, {
      body: { approved: true, snapshotHash: state.planHash, comment: `e2e ${id}` },
      expectStatus: 200,
    });
    assert.equal(data.status, "APPROVED");
  });

  step(
    "run produces a verified diff awaiting publish approval",
    async () => {
      const execution = await waitForStatus(state.executionId, "AWAITING_PUBLISH_APPROVAL", RUN_TIMEOUT_MS);
      const diff = execution.artifacts.find((artifact) => artifact.type === "DIFF");
      assert.ok(diff, "DIFF artifact recorded");
      state.publishHash = pendingApproval(execution, "PUBLISH")?.snapshotHash;
      assert.equal(state.publishHash, diff.sha256, "publish approval is bound to the diff artifact hash");
    },
    { timeout: RUN_TIMEOUT_MS + 30_000 },
  );

  step(
    "publish approval opens a draft PR and comments on the card",
    async (t) => {
      if (env("E2E_PUBLISH", "true") === "false") {
        await api("POST", `/api/executions/${state.executionId}/approvals/publish`, {
          body: { approved: false, snapshotHash: state.publishHash, comment: "E2E_PUBLISH=false" },
          expectStatus: 200,
        });
        assert.equal((await getExecution(state.executionId)).status, "CANCELED");
        t.diagnostic("E2E_PUBLISH=false: rejected publish instead of opening a PR");
        return;
      }

      await api("POST", `/api/executions/${state.executionId}/approvals/publish`, {
        body: { approved: true, snapshotHash: state.publishHash, comment: `e2e ${id}` },
        expectStatus: 200,
      });
      state.branch = `agent/${state.executionId}`;
      const execution = await waitForStatus(state.executionId, "COMPLETED", PUBLISH_TIMEOUT_MS);
      assert.equal(execution.branchName, state.branch);

      const pr = execution.artifacts.find((artifact) => artifact.type === "PULL_REQUEST");
      assert.ok(pr?.metadata?.html_url, "PULL_REQUEST artifact with a URL");
      state.prUrl = pr.metadata.html_url;
      state.prNumber = pr.metadata.number;
      t.diagnostic(`draft PR ${state.prUrl}`);

      if (env("E2E_GITHUB_TOKEN")) {
        const remote = await github("GET", `${repoPath()}/pulls/${state.prNumber}`);
        assert.equal(remote.draft, true, "PR must be a draft");
        assert.equal(remote.head.ref, state.branch);
      }

      // The tracker comment is posted right after COMPLETED; allow a short lag.
      await poll(
        "the PR link comment on the Trello card",
        async () => {
          const comments = await trello("GET", `/cards/${state.cardId}/actions`, { filter: "commentCard" });
          return comments.some((action) => action.data?.text?.includes(state.prUrl)) ? true : undefined;
        },
        { timeoutMs: 60_000 },
      );
    },
    { timeout: PUBLISH_TIMEOUT_MS + 120_000 },
  );
});
