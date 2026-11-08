// Coding benchmark runner (Phase 0 of docs/plans/AGENTIC_ROADMAP.md).
//
//   npm run eval:coding                       every scenario, E2E_EVAL_RUNS times
//   npm run eval:coding -- --scenario python  one suite (node, python, go)
//   npm run eval:coding -- --scenario node/01,go   by id or prefix ("01" is 01 of every suite)
//   npm run eval:coding -- --runs 3           runs per scenario
//   npm run eval:coding -- --parallel 4       4 runs at once, one sandbox repo each (E2E_GITHUB_EXTRA_REPOS)
//   npm run eval:coding -- --check            check the setup without any LLM calls
//
// For each run: point the sandbox repo's main at the scenario's code -> create
// the Trello card -> approve the plan -> wait for a diff or BLOCKED -> reject
// publishing (no PR is opened) -> grade the diff in Docker with the repo's own
// tests and the hidden test -> record the outcome. Writes
// docs/testing/coding-eval-<date>.md and restores main to the clean project.
//
// Needs everything the execution e2e suite needs plus E2E_GITHUB_TOKEN with
// Contents read/write on the sandbox repo. It REWRITES that repo's main branch.
// With --parallel N, runs share out over E2E_GITHUB_REPO and the first N-1 of
// E2E_GITHUB_EXTRA_REPOS (comma-separated, same owner and GitHub App), each with
// its own card label, so the token needs those too; the server runs that many
// executions at once only with EXECUTION_RUN_CONCURRENCY set to at least N.
//
// Each suite (a project in one language) runs with its own environment from
// suite.json, set on the sandbox repository first.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const { api, assertServerHealthy, env, envInt, poll, runId, skipUnless } = require("./helpers");
const { cleanFiles, diffStats, grade, isTestFile, loadScenarios, loadSuites, scenarioFiles } = require("./codingScenarios");
const {
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
} = require("./pipeline");

const execFileAsync = promisify(execFile);
// The suite the sandbox repository is left on, which the other e2e suites expect.
const DEFAULT_SUITE = "node";
// The plan step clones the repository and makes the triage and plan calls.
const PLAN_TIMEOUT_MS = envInt("E2E_PLAN_TIMEOUT_MS", 600_000);
const RUN_TIMEOUT_MS = envInt("E2E_RUN_TIMEOUT_MS", 1_200_000);
const RUN_END_STATES = ["AWAITING_PUBLISH_APPROVAL", "BLOCKED", "FAILED", "CANCELED"];
const REPORT_DIR = path.resolve(__dirname, "..", "..", "docs", "testing");

const OUTCOMES = {
  correct_fix: "Correct fix",
  wrong_fix_shipped: "Wrong fix shipped",
  wrong_fix_flagged: "Wrong fix, reviewer objected",
  correctly_blocked: "Correctly blocked",
  no_fix: "No fix (blocked)",
  infra_failure: "Infrastructure failure",
};

const parseArgs = (argv) => {
  const options = { scenarios: null, runs: envInt("E2E_EVAL_RUNS", 1), parallel: 1, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split("=");
    const value = () => inline ?? argv[++index];
    if (flag === "--check") options.check = true;
    else if (flag === "--scenario") options.scenarios = value().split(",").map((id) => id.trim());
    else if (flag === "--runs") options.runs = Number.parseInt(value(), 10);
    else if (flag === "--parallel") options.parallel = Number.parseInt(value(), 10);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!(options.runs >= 1)) throw new Error("--runs must be a positive number");
  if (!(options.parallel >= 1)) throw new Error("--parallel must be a positive number");
  return options;
};

const log = (message) => console.log(`[eval ${new Date().toISOString().slice(11, 19)}] ${message}`);

/** Replaces the whole tree of the sandbox repo's default branch with `files`. */
const setDefaultBranch = async (files, message, repo) => {
  const branch = env("E2E_GITHUB_DEFAULT_BRANCH", "main");
  const ref = await github("GET", `${repoPath(repo)}/git/ref/heads/${branch}`);
  // No base_tree: files that are not listed are removed.
  const tree = await github("POST", `${repoPath(repo)}/git/trees`, {
    tree: [...files].map(([file, content]) => ({ path: file, mode: "100644", type: "blob", content })),
  });
  const commit = await github("POST", `${repoPath(repo)}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  await github("PATCH", `${repoPath(repo)}/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha;
};

/**
 * Setup check without LLM calls: creating a tree and a commit proves the
 * token can write Contents, but no branch is moved.
 */
const checkSetup = async (slots) => {
  const branch = env("E2E_GITHUB_DEFAULT_BRANCH", "main");
  for (const { repo } of slots) {
    const ref = await github("GET", `${repoPath(repo)}/git/ref/heads/${branch}`);
    const tree = await github("POST", `${repoPath(repo)}/git/trees`, {
      tree: [{ path: "README.md", mode: "100644", type: "blob", content: "setup check\n" }],
    });
    await github("POST", `${repoPath(repo)}/git/commits`, {
      message: "benchmark: setup check (never referenced)",
      tree: tree.sha,
      parents: [ref.object.sha],
    });
  }
  for (const suite of loadSuites()) {
    const result = await grade(suite, cleanFiles(suite), new Map());
    if (!result.visiblePassed) throw new Error(`${suite.name}: grading container failed:\n${result.output}`);
  }
  log(`setup OK: server, Docker grading, Trello fixtures, and write access to ${slots.map(({ repo }) => repoPath(repo)).join(", ")} (${branch} untouched)`);
};

/** Grades an approved diff: the scenario's code with the diff applied, its own tests, then the hidden test. */
const gradeDiff = (scenario, diff) => grade(scenario.suite, scenarioFiles(scenario), scenario.hiddenFiles, diff);

/** The environment a suite runs with: its suite.json, or E2E_ENVIRONMENT for every suite. */
const suiteEnvironment = (suite) =>
  process.env.E2E_ENVIRONMENT ? JSON.parse(process.env.E2E_ENVIRONMENT) : suite.environment;

/** Sets the sandbox repository's environment, if it differs. */
const useEnvironment = async (fixtures, verificationConfig) => {
  if (JSON.stringify(fixtures.repository.verificationConfig) === JSON.stringify(verificationConfig)) return;
  const { data } = await api("PATCH", `/api/repositories/${fixtures.repository.id}`, {
    body: { verificationConfig },
    expectStatus: 200,
  });
  fixtures.repository = data;
};

/** Mode, attempts, LLM calls and prompt versions, read from the execution's events. */
const eventMetrics = (events) => {
  const ofType = (type) => events.filter((event) => event.type === type);
  const context = ofType("GRAPH_CONTEXT_LOADED")[0]?.payload;
  // A single-shot attempt is one implement call; a tool-loop attempt records
  // each model call as a GRAPH_AGENT_STEP (with a promptVersion).
  const llmCalls = events.filter(
    (event) =>
      (event.type === "GRAPH_ATTEMPT_STARTED" && event.payload?.agentMode !== "tool_loop") ||
      event.payload?.promptVersion,
  ).length;
  const loopTokens = ofType("GRAPH_AGENT_FINISHED").reduce(
    (sum, event) => sum + (event.payload?.usage?.inputTokens ?? 0) + (event.payload?.usage?.outputTokens ?? 0),
    0,
  );
  return {
    agentMode: context?.agentMode ?? "single_shot",
    attempts: ofType("GRAPH_ATTEMPT_STARTED").length,
    llmCalls,
    loopTokens,
    promptVersions: context?.promptVersions ?? null,
  };
};

const runScenario = async (fixtures, scenario, runNumber) => {
  const id = runId();
  const started = Date.now();
  const result = { scenario: scenario.id, language: scenario.suite.language, run: runNumber, outcome: "infra_failure", note: "" };
  let cardId;
  try {
    await useEnvironment(fixtures, suiteEnvironment(scenario.suite));
    const baseSha = await setDefaultBranch(scenarioFiles(scenario), `benchmark: ${scenario.id} (${id})`, fixtures.repo);
    cardId = await createCard(`[${id}] ${scenario.title}`, scenario.description, fixtures.label);
    const workItem = await ingestCard(fixtures, cardId);
    const { data: detail } = await api("GET", `/api/work-items/${workItem.id}`, { expectStatus: 200 });
    result.executionId = detail.executions[0].id;
    log(`${scenario.id} run ${runNumber}: execution ${result.executionId}`);

    // A declined ticket ends at the plan step; waiting for the run then returns at once.
    await approvePlan(result.executionId, PLAN_TIMEOUT_MS);
    const execution = await waitForAnyStatus(result.executionId, RUN_END_STATES, RUN_TIMEOUT_MS);
    Object.assign(result, eventMetrics(execution.events), usageMetrics(execution.usage));
    if (execution.baseSha && execution.baseSha !== baseSha)
      throw new Error(`run used base ${execution.baseSha}, expected the scenario commit ${baseSha}`);

    if (execution.status === "AWAITING_PUBLISH_APPROVAL") {
      const artifact = execution.artifacts.find((candidate) => candidate.type === "DIFF");
      // The runner reads the server's disk; the hash proves it is the approved diff.
      const diff = fs.readFileSync(artifactPath(artifact), "utf8");
      // Same formula as hashSnapshot in src/services/executionService.ts.
      if (crypto.createHash("sha256").update(JSON.stringify(diff)).digest("hex") !== artifact.sha256)
        throw new Error("diff artifact does not match its recorded sha256");
      // Never open a PR during the benchmark.
      await api("POST", `/api/executions/${result.executionId}/approvals/publish`, {
        body: { approved: false, snapshotHash: pendingApproval(execution, "PUBLISH").snapshotHash, comment: "coding eval" },
        expectStatus: 200,
      });

      // Attempts ran out with the reviewer still objecting; the approver sees its objections.
      const objections = artifact.metadata?.reviewObjections ?? [];
      const objected = objections.length ? `reviewer objected: ${objections.join(" / ").slice(0, 200)}` : "";
      // The approver must be told on the ticket; the comment follows the run step by a moment.
      if (objections.length)
        await poll(
          "the reviewer objections comment on the Trello card",
          async () => {
            const comments = await trello("GET", `/cards/${cardId}/actions`, { filter: "commentCard" });
            return comments.some((action) => action.data?.text?.includes("The reviewer objected to this change")) ? true : undefined;
          },
          { timeoutMs: 60_000 },
        );

      const stats = diffStats(diff);
      result.files = stats.files;
      result.linesAdded = stats.added;
      result.linesRemoved = stats.removed;
      // Adding test cases is fine; changing or deleting existing ones is the gaming risk.
      const testFile = (file) => isTestFile(scenario.suite, file);
      const addedTest = (file) => testFile(file) && !stats.editedFiles.includes(file);
      result.testsModified = stats.editedFiles.some(testFile);
      result.testsAdded = stats.files.some(addedTest);
      // Added tests are reported in their own column, so they don't count as unexpected files.
      result.onlyExpectedFiles = stats.files.every((file) => addedTest(file) || scenario.expectedFiles.includes(file));

      if (scenario.expect === "blocked") {
        result.outcome = "wrong_fix_shipped";
        result.note = "a PR would have been opened for an impossible ticket";
      } else {
        const graded = await gradeDiff(scenario, diff);
        if (!graded.applied) {
          result.note = `diff did not apply: ${graded.output.trim().slice(0, 300)}`;
        } else if (graded.visiblePassed && graded.hiddenPassed) {
          result.outcome = "correct_fix";
        } else {
          result.outcome = "wrong_fix_shipped";
          result.note = graded.hiddenPassed ? "repo tests failed" : "hidden test failed";
          result.gradeOutput = graded.output.slice(-1500);
        }
      }
      if (objected) result.note = [result.note, objected].filter(Boolean).join("; ");
      // The approver was warned, so it is not a silent wrong fix.
      if (objected && result.outcome === "wrong_fix_shipped") result.outcome = "wrong_fix_flagged";
    } else if (execution.status === "BLOCKED") {
      result.outcome = scenario.expect === "blocked" ? "correctly_blocked" : "no_fix";
      result.note = (execution.lastError ?? "").replace(/\s+/g, " ").slice(0, 200);
    } else {
      result.note = `${execution.status}: ${(execution.lastError ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
    }
  } catch (error) {
    result.outcome = "infra_failure";
    result.note = error.message.replace(/\s+/g, " ").slice(0, 300);
  } finally {
    result.durationMs = Date.now() - started;
    if (cardId && env("E2E_KEEP_RESOURCES") !== "true")
      await trello("DELETE", `/cards/${cardId}`).catch((error) => log(`could not delete card: ${error.message}`));
  }
  if (result.executionId && result.attempts === undefined) {
    const execution = await getExecution(result.executionId).catch(() => ({ events: [] }));
    Object.assign(result, eventMetrics(execution.events), usageMetrics(execution.usage));
  }
  log(`${scenario.id} run ${runNumber}: ${OUTCOMES[result.outcome]}${result.note ? ` (${result.note})` : ""}`);
  return result;
};

// Optional prices per million tokens, "input,cached input,output" (e.g. "0.25,0.025,2"), for the cost column;
// per model when calls use several: "gpt-5-mini=0.25,0.025,2;gpt-5-nano=0.05,0.005,0.4".
const prices = (model) => {
  const spec = env("E2E_PRICE_PER_MTOK", "");
  const entries = spec.split(";").map((entry) => entry.split("="));
  const own = entries.length === 1 && entries[0].length === 1 ? entries[0][0] : entries.find(([name]) => name === model)?.[1];
  const values = (own ?? "").split(",").map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : undefined;
};

/** All of an execution's model calls (GET /api/executions/:id usage), with cost when prices are set. */
const usageMetrics = (usage = []) => {
  const sum = (key) => usage.reduce((total, row) => total + (row[key] ?? 0), 0);
  const rowCost = (row) => {
    const [input, cached, output] = prices(row.model) ?? [];
    return input === undefined
      ? undefined
      : ((row.inputTokens - row.cachedInputTokens) * input + row.cachedInputTokens * cached + row.outputTokens * output) / 1e6;
  };
  const costs = usage.map(rowCost);
  return {
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    // No cost unless every model used has a price.
    costUsd: costs.length && costs.every((cost) => cost !== undefined) ? costs.reduce((a, b) => a + b, 0) : undefined,
  };
};

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "n/a");
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const summarize = (results) => {
  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  const graded = results.length - count("infra_failure");
  const attempts = results.filter((result) => result.attempts);
  return {
    runs: results.length,
    correct: count("correct_fix"),
    wrong: count("wrong_fix_shipped"),
    flagged: count("wrong_fix_flagged"),
    blocked: count("correctly_blocked"),
    noFix: count("no_fix"),
    infra: count("infra_failure"),
    graded,
    avgAttempts: attempts.length
      ? (attempts.reduce((sum, result) => sum + result.attempts, 0) / attempts.length).toFixed(1)
      : "n/a",
  };
};

const runTokens = (result) => {
  const total = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  if (!total) return "";
  const cached = result.inputTokens ? Math.round((result.cachedInputTokens / result.inputTokens) * 100) : 0;
  return ` (${Math.round(total / 1000)}k tokens, ${cached}% cached${result.costUsd === undefined ? "" : `, $${result.costUsd.toFixed(3)}`})`;
};

const totalCost = (results) =>
  env("E2E_PRICE_PER_MTOK") ? results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0) : undefined;

const writeReport = (results, meta) => {
  const summary = summarize(results);
  const promptVersions = results.find((result) => result.promptVersions)?.promptVersions;
  const promptList = promptVersions ? Object.values(promptVersions).join(", ") : "unknown";
  const lines = [
    `# Coding evaluation ${meta.date}`,
    "",
    "Generated by `npm run eval:coding` (tests/e2e/codingEval.js). Scenarios: `tests/e2e/coding-scenarios/`.",
    "",
    "| | |",
    "| --- | --- |",
    `| Mode | ${[...new Set(results.map((result) => result.agentMode).filter(Boolean))].join(", ") || "unknown"} |`,
    `| Model | ${env("E2E_LLM_PROVIDER")} / ${env("E2E_LLM_MODEL")} |`,
    `| Prompt versions | ${promptList} |`,
    `| Code version | ${meta.commit} |`,
    `| Runs per scenario | ${meta.runs} |`,
    `| Duration | ${Math.round(meta.durationMs / 60000)} min |`,
    "",
    "## Summary",
    "",
    "Rates exclude infrastructure failures. **Wrong fix shipped** is the key number: a PR a human reviewer would have to catch with no warning. **Wrong fix, reviewer objected** reached publish approval with the reviewer's objections shown to the approver.",
    "",
    "| Runs | Correct fix | Wrong fix shipped | Wrong fix, reviewer objected | Correctly blocked | No fix (blocked) | Infra failures | Pass rate | Wrong-fix-shipped rate | Avg attempts |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${summary.runs} | ${summary.correct} | ${summary.wrong} | ${summary.flagged} | ${summary.blocked} | ${summary.noFix} | ${summary.infra} | ${percent(summary.correct + summary.blocked, summary.graded)} | ${percent(summary.wrong, summary.graded)} | ${summary.avgAttempts} |`,
    "",
    "By language:",
    "",
    "| Language | Runs | Correct fix | Wrong fix shipped | Wrong fix, reviewer objected | Correctly blocked | No fix (blocked) | Infra failures |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...[...new Set(results.map((result) => result.language))].map((language) => {
      const own = summarize(results.filter((result) => result.language === language));
      return `| ${language} | ${own.runs} | ${own.correct} | ${own.wrong} | ${own.flagged} | ${own.blocked} | ${own.noFix} | ${own.infra} |`;
    }),
    "",
    "## Runs",
    "",
    "| Scenario | Run | Outcome | Attempts | LLM calls | Duration | Files changed | Lines +/- | Only expected files (besides added tests) | Tests added | Existing tests changed | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.scenario} | ${result.run} | ${OUTCOMES[result.outcome]} | ${result.attempts ?? ""} | ${result.llmCalls ?? ""}${runTokens(result)} | ${Math.round(result.durationMs / 1000)}s | ${cell((result.files ?? []).join(", "))} | ${result.files ? `+${result.linesAdded}/-${result.linesRemoved}` : ""} | ${result.files ? (result.onlyExpectedFiles ? "yes" : "no") : ""} | ${result.files ? (result.testsAdded ? "yes" : "no") : ""} | ${result.files ? (result.testsModified ? "**yes**" : "no") : ""} | ${cell(result.note)} |`,
    ),
    "",
    "Tokens are every model call the execution made (input + output), with the share of input read from the provider's prompt cache" + (env("E2E_PRICE_PER_MTOK") ? " and the cost at E2E_PRICE_PER_MTOK." : "; set E2E_PRICE_PER_MTOK to add cost."),
    ...(totalCost(results) === undefined ? [] : ["", `Total cost: $${totalCost(results).toFixed(2)}.`]),
    "",
  ];
  const failures = results.filter((result) => result.gradeOutput);
  if (failures.length) {
    lines.push("## Grading output of wrong fixes", "");
    for (const result of failures)
      lines.push(`### ${result.scenario} run ${result.run}`, "", "```text", result.gradeOutput.trim(), "```", "");
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  let file = path.join(REPORT_DIR, `coding-eval-${meta.date}.md`);
  for (let suffix = 2; fs.existsSync(file); suffix += 1)
    file = path.join(REPORT_DIR, `coding-eval-${meta.date}-${suffix}.md`);
  fs.writeFileSync(file, lines.join("\n"));

  const logRow = `| ${meta.date} | | ${[...new Set(results.map((result) => result.agentMode).filter(Boolean))].join(", ") || "unknown"} | ${env("E2E_LLM_MODEL")} | ${promptList} | none | ${summary.runs} | ${summary.correct} | ${summary.wrong} | ${summary.blocked} | ${summary.infra} | ${summary.avgAttempts} | [report](../testing/${path.basename(file)}) |`;
  return { file, summary, logRow };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const missing = skipUnless([...PIPELINE_ENV, "E2E_GITHUB_TOKEN"]);
  if (missing) throw new Error(missing);

  let scenarios = loadScenarios();
  if (options.scenarios) {
    const matches = (scenario, id) => scenario.id.startsWith(id) || scenario.id.split("/")[1].startsWith(id);
    scenarios = scenarios.filter((scenario) => options.scenarios.some((id) => matches(scenario, id)));
    if (!scenarios.length) throw new Error(`No scenario matches ${options.scenarios.join(", ")}`);
  }

  await assertServerHealthy();
  await execFileAsync("docker", ["version"]).catch(() => {
    throw new Error("Docker is not available; it is needed to grade diffs.");
  });
  // One sandbox repository and card label per parallel slot; the first is the usual one.
  const repos = [env("E2E_GITHUB_REPO"), ...env("E2E_GITHUB_EXTRA_REPOS", "").split(",").map((repo) => repo.trim()).filter(Boolean)];
  if (options.parallel > repos.length)
    throw new Error(`--parallel ${options.parallel} needs ${options.parallel - 1} repositories in E2E_GITHUB_EXTRA_REPOS`);
  const slots = [];
  // In turn: each call also refreshes the shared project and agent.
  for (const [index, repo] of repos.slice(0, options.parallel).entries())
    slots.push(await ensureFixtures({ repo, label: index ? `${env("E2E_TRELLO_LABEL")}-${index + 1}` : env("E2E_TRELLO_LABEL") }));
  if (options.check) return checkSetup(slots);
  const { stdout: commit } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "unknown" }));

  const started = Date.now();
  log(`${scenarios.length} scenario(s) in ${[...new Set(scenarios.map((scenario) => scenario.suite.name))].join(", ")} x ${options.runs} run(s) with ${env("E2E_LLM_PROVIDER")}/${env("E2E_LLM_MODEL")}`);
  const jobs = scenarios.flatMap((scenario) => Array.from({ length: options.runs }, (_, index) => ({ scenario, run: index + 1 })));
  const results = new Array(jobs.length);
  let next = 0;
  try {
    // Each slot takes the next job when its run ends; results keep the job order.
    await Promise.all(
      slots.map(async (fixtures) => {
        while (next < jobs.length) {
          const index = next++;
          results[index] = await runScenario(fixtures, jobs[index].scenario, jobs[index].run);
        }
      }),
    );
  } finally {
    // Leave each sandbox on the clean project so other suites start from it.
    const suite = loadSuites().find((candidate) => candidate.name === DEFAULT_SUITE);
    for (const fixtures of slots) {
      await setDefaultBranch(cleanFiles(suite), "benchmark: restore clean project", fixtures.repo).catch((error) =>
        log(`could not restore ${fixtures.repo} ${env("E2E_GITHUB_DEFAULT_BRANCH", "main")}: ${error.message}`),
      );
      await useEnvironment(fixtures, suiteEnvironment(suite)).catch((error) =>
        log(`could not restore ${fixtures.repo}'s environment: ${error.message}`),
      );
    }
  }

  const report = writeReport(results, {
    // Local calendar date (the "sv" locale formats as YYYY-MM-DD).
    date: new Date().toLocaleDateString("sv"),
    commit: commit.trim(),
    runs: options.runs,
    durationMs: Date.now() - started,
  });
  const { summary } = report;
  log(
    `done: ${summary.correct} correct, ${summary.wrong} wrong fix shipped, ${summary.flagged} wrong fix with reviewer objections, ${summary.blocked} correctly blocked, ` +
      `${summary.noFix} no fix, ${summary.infra} infra failures`,
  );
  log(`report: ${path.relative(process.cwd(), report.file)}`);
  log(`results-log row for docs/plans/AGENTIC_ROADMAP.md:\n${report.logRow}`);
};

if (require.main === module)
  main().catch((error) => {
    console.error(`[eval] ${error.message}`);
    process.exitCode = 1;
  });

module.exports = { OUTCOMES, eventMetrics, gradeDiff, log, parseArgs, prices, setDefaultBranch, suiteEnvironment, summarize, usageMetrics, useEnvironment };
