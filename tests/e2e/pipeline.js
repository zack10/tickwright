// Execution-pipeline helpers shared by the e2e suite and the coding benchmark:
// Trello/GitHub calls, the long-lived fixtures, and waiting on executions.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { loadSuites } = require("./codingScenarios");
const { api, env, external, poll } = require("./helpers");

const PIPELINE_ENV = [
  "E2E_LLM_PROVIDER",
  "E2E_LLM_MODEL",
  "E2E_LLM_API_KEY",
  "E2E_TRELLO_API_KEY",
  "E2E_TRELLO_TOKEN",
  "E2E_TRELLO_BOARD_ID",
  "E2E_TRELLO_LIST_ID",
  "E2E_TRELLO_LABEL",
  "E2E_GITHUB_OWNER",
  "E2E_GITHUB_REPO",
  "E2E_GITHUB_INSTALLATION_ID",
];
const FAILED_STATES = ["BLOCKED", "FAILED", "CANCELED"];

const trello = (method, path, query = {}) =>
  external(method, `https://api.trello.com/1${path}`, {
    query: { ...query, key: env("E2E_TRELLO_API_KEY"), token: env("E2E_TRELLO_TOKEN") },
  });

const github = (method, path, body) =>
  external(method, `https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${env("E2E_GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
    body,
  });

const repoPath = (repo = env("E2E_GITHUB_REPO")) => `/repos/${env("E2E_GITHUB_OWNER")}/${repo}`;

/** Gives an empty repository its first commit, so the benchmark has a branch to move. */
const ensureBranch = async (repo) => {
  const branch = env("E2E_GITHUB_DEFAULT_BRANCH", "main");
  // An empty repository answers 409 (or 404) for any ref.
  const exists = await github("GET", `${repoPath(repo)}/git/ref/heads/${branch}`).then(() => true, () => false);
  if (!exists)
    await github("PUT", `${repoPath(repo)}/contents/README.md`, {
      message: "benchmark: first commit",
      content: Buffer.from("Benchmark sandbox\n").toString("base64"),
      branch,
    });
};

/** Creates a board label unless it exists; parallel benchmark slots each pick up their own. */
const ensureLabel = async (name) => {
  const labels = await trello("GET", `/boards/${env("E2E_TRELLO_BOARD_ID")}/labels`);
  if (!labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))
    await trello("POST", "/labels", { idBoard: env("E2E_TRELLO_BOARD_ID"), name, color: "sky" });
};

const getExecution = async (executionId) =>
  (await api("GET", `/api/executions/${executionId}`, { expectStatus: 200 })).data;

const pendingApproval = (execution, type) =>
  execution.approvals.find((approval) => approval.type === type && approval.status === "PENDING");

/** Waits for `target`, failing fast with the error and recent events if the execution dies. */
const waitForStatus = (executionId, target, timeoutMs) =>
  poll(
    `execution ${executionId} to reach ${target}`,
    async (seen) => {
      const execution = await getExecution(executionId);
      seen({ status: execution.status, lastError: execution.lastError });
      if (execution.status === target) return execution;
      if (FAILED_STATES.includes(execution.status)) {
        const events = execution.events.slice(-8).map((event) => event.type).join(" -> ");
        throw new Error(
          `Execution ${executionId} reached ${execution.status} while waiting for ${target}.\n` +
            `lastError: ${execution.lastError ?? "none"}\nrecent events: ${events}`,
        );
      }
      return undefined;
    },
    { timeoutMs },
  );

/** Waits until the execution reaches any of `targets` and returns it. */
const waitForAnyStatus = (executionId, targets, timeoutMs) =>
  poll(
    `execution ${executionId} to reach one of ${targets.join(", ")}`,
    async (seen) => {
      const execution = await getExecution(executionId);
      seen({ status: execution.status, lastError: execution.lastError });
      return targets.includes(execution.status) ? execution : undefined;
    },
    { timeoutMs },
  );

/**
 * Waits for the plan step (clone, triage, plan) and approves the plan through
 * the API, as a person would. Returns false when the execution ended there
 * instead, e.g. because the agent declined the ticket.
 */
const approvePlan = async (executionId, timeoutMs) => {
  const planned = await waitForAnyStatus(executionId, ["AWAITING_PLAN_APPROVAL", ...FAILED_STATES], timeoutMs);
  if (planned.status !== "AWAITING_PLAN_APPROVAL") return false;
  await api("POST", `/api/executions/${executionId}/approvals/plan`, {
    body: { approved: true, snapshotHash: pendingApproval(planned, "PLAN").snapshotHash },
    expectStatus: 200,
  });
  return true;
};

/**
 * Reuses the long-lived e2e project/agent/repository/integration so runs don't pile up rows.
 * `repo` and `label` pick another sandbox repository and the card label its integration picks up.
 */
const ensureFixtures = async ({ repo = env("E2E_GITHUB_REPO"), label = env("E2E_TRELLO_LABEL") } = {}) => {
  const projectName = "e2e-execution-pipeline";
  const { data: projects } = await api("GET", "/api/projects", { expectStatus: 200 });
  const project =
    projects.find((candidate) => candidate.name === projectName) ??
    (await api("POST", "/api/projects", { body: { name: projectName }, expectStatus: 201 })).data;

  // The run step uses the project's first agent, so keep exactly one and refresh its key.
  const agentBody = {
    name: "e2e-implementer",
    provider: env("E2E_LLM_PROVIDER"),
    model: env("E2E_LLM_MODEL"),
    config: {
      apiKey: env("E2E_LLM_API_KEY"),
      // e.g. {"triage":"low","plan":"low","analyze":"low"}; unset keeps each model's default.
      ...(env("E2E_REASONING_EFFORT") ? { reasoningEffort: JSON.parse(env("E2E_REASONING_EFFORT")) } : {}),
      // e.g. {"triage":{"provider":"openai","model":"gpt-5-nano"}}; unset runs every call on E2E_LLM_MODEL.
      ...(env("E2E_CALL_MODELS") ? { models: JSON.parse(env("E2E_CALL_MODELS")) } : {}),
    },
  };
  const { data: agents } = await api("GET", "/api/agents", { expectStatus: 200 });
  const agent = agents.find((candidate) => candidate.projectId === project.id);
  if (agent) await api("PUT", `/api/agents/${agent.id}`, { body: agentBody, expectStatus: 200 });
  else await api("POST", "/api/agents", { body: { ...agentBody, projectId: project.id }, expectStatus: 201 });

  // The sandbox repository's environment, as a person would approve it: the
  // e2e suites use the Node benchmark project, so its suite.json environment.
  // E2E_ENVIRONMENT (JSON verificationConfig) replaces it for a repository in
  // another stack, or with no checks to exercise discovery.
  const verificationConfig = process.env.E2E_ENVIRONMENT
    ? JSON.parse(process.env.E2E_ENVIRONMENT)
    : loadSuites().find((suite) => suite.name === "node").environment;

  // Repositories are unique by owner/name, so reuse one if it already exists,
  // updating its environment when it differs.
  const owner = env("E2E_GITHUB_OWNER");
  const name = repo;
  await ensureBranch(repo);
  if (label !== env("E2E_TRELLO_LABEL")) await ensureLabel(label);
  const { data: repositories } = await api("GET", "/api/repositories", { expectStatus: 200 });
  let existing = repositories.find((candidate) => candidate.owner === owner && candidate.name === name);
  // Keep the updated row: callers compare its environment to decide whether to switch it.
  if (existing && JSON.stringify(existing.verificationConfig) !== JSON.stringify(verificationConfig))
    existing = (await api("PATCH", `/api/repositories/${existing.id}`, { body: { verificationConfig }, expectStatus: 200 })).data;
  const repository =
    existing ??
    (
      await api("POST", "/api/repositories", {
        body: {
          projectId: project.id,
          owner,
          name,
          defaultBranch: env("E2E_GITHUB_DEFAULT_BRANCH", "main"),
          githubInstallationId: env("E2E_GITHUB_INSTALLATION_ID"),
          verificationConfig,
          executionPolicy: { maxChangedFiles: 5 },
        },
        expectStatus: 201,
      })
    ).data;

  // Integration configs are encrypted and have no update endpoint, so the name
  // carries a hash of the config: changing any E2E_TRELLO_* value creates a new one.
  const trelloConfig = {
    apiKey: env("E2E_TRELLO_API_KEY"),
    token: env("E2E_TRELLO_TOKEN"),
    boardId: env("E2E_TRELLO_BOARD_ID"),
    eligibleLabel: label,
    repositoryId: repository.id,
  };
  const integrationName = `e2e-trello-${crypto.createHash("sha256").update(JSON.stringify(trelloConfig)).digest("hex").slice(0, 12)}`;
  const { data: integrations } = await api("GET", `/api/integrations?projectId=${project.id}`, { expectStatus: 200 });
  const integration =
    integrations.find((candidate) => candidate.name === integrationName) ??
    (
      await api("POST", "/api/integrations", {
        body: { projectId: project.id, type: "TRELLO", name: integrationName, config: trelloConfig },
        expectStatus: 201,
      })
    ).data;

  return { project, repository, integration, repo, label };
};

/** Creates a card carrying the eligibility label; returns its id. */
const createCard = async (name, desc, labelName = env("E2E_TRELLO_LABEL")) => {
  const labels = await trello("GET", `/boards/${env("E2E_TRELLO_BOARD_ID")}/labels`);
  const label = labels.find((candidate) => candidate.name.toLowerCase() === labelName.toLowerCase());
  assert.ok(label, `label "${labelName}" does not exist on the board`);
  const card = await trello("POST", "/cards", { idList: env("E2E_TRELLO_LIST_ID"), idLabels: label.id, name, desc });
  return card.id;
};

/** Syncs the integration and returns the work item created for the card. */
const ingestCard = async ({ integration, project }, cardId) => {
  const { data } = await api("POST", `/api/integrations/${integration.id}/sync`, { expectStatus: 200 });
  assert.ok(data.ingested >= 1, `expected the new card to be ingested, got ${JSON.stringify(data)}`);

  const { data: workItems } = await api("GET", `/api/work-items?projectId=${project.id}`, { expectStatus: 200 });
  const workItem = workItems.find((candidate) => candidate.externalId === cardId);
  assert.ok(workItem, "work item for the new card not found");
  return workItem;
};

/**
 * Where this runner can read an artifact the server wrote. The server reports
 * its own path; E2E_ARTIFACT_DIR is that folder as seen from here when the
 * server runs elsewhere (e.g. the production stack in WSL, the runner on Windows).
 */
const artifactPath = (artifact) => {
  const dir = env("E2E_ARTIFACT_DIR");
  return dir ? path.join(dir, path.posix.basename(artifact.storagePath)) : artifact.storagePath;
};

module.exports = {
  FAILED_STATES,
  PIPELINE_ENV,
  approvePlan,
  artifactPath,
  createCard,
  ensureFixtures,
  getExecution,
  github,
  ingestCard,
  pendingApproval,
  repoPath,
  trello,
  waitForAnyStatus,
  waitForStatus,
};
