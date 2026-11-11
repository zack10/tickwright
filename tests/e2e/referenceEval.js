// Reference projects: real issues in real projects, from a public benchmark
// of verified instances (Multi-SWE-bench), run through the whole pipeline.
//
// Per project: the project at the issue's base commit becomes the sandbox
// repo's main -> the issue becomes a Trello card -> approve the plan ->
// the agent works, with no environment configured (discovery finds it) ->
// reject publishing -> grade the diff the way the benchmark does: in its
// own image, without network, with the instance's test patch added, every
// FAIL_TO_PASS and PASS_TO_PASS test must pass (JUnit XML reports, or the
// test log matched with the project's grader.resultPattern).
// Writes docs/testing/reference-<date>.md and restores main.
//
// --parallel N: N projects at once, one sandbox repo and card label each, as
// in codingEval.js (E2E_GITHUB_EXTRA_REPOS, EXECUTION_RUN_CONCURRENCY >= N).
//
// --runs N: each project N times (a conclusion needs at least 10).
//
// --ticket NAME: the card is reference-projects/tickets/<id, / as __>.NAME.md
// ("# title", then the body) instead of the project's GitHub issue, e.g. a
// clarified ticket, to tell an unclear ticket from the model or the agent.
//
// --publish (one project only): approve publishing instead, so the run
// opens a draft PR on the sandbox repo, and leave main at the project so
// the PR's diff stays readable; the next run without it restores main.
//
// Needs what the coding eval needs (see codingEval.js). It REWRITES the
// sandbox repo's main.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { api, assertServerHealthy, env, envInt, runId, skipUnless } = require("./helpers");
const { cleanFiles, diffStats, loadSuites } = require("./codingScenarios");
const {
  OUTCOMES,
  eventMetrics,
  log,
  setDefaultBranch,
  suiteEnvironment,
  usageMetrics,
  useEnvironment,
} = require("./codingEval");
const {
  PIPELINE_ENV,
  approvePlan,
  artifactPath,
  createCard,
  ensureFixtures,
  github,
  ingestCard,
  pendingApproval,
  repoPath,
  trello,
  waitForAnyStatus,
  waitForStatus,
} = require("./pipeline");

const execFileAsync = promisify(execFile);
const PROJECTS_FILE = path.join(__dirname, "reference-projects", "projects.json");
const TICKETS_DIR = path.join(__dirname, "reference-projects", "tickets");
const CACHE_DIR = path.resolve(__dirname, "..", "..", "scratch", "reference-cache");
const REPORT_DIR = path.resolve(__dirname, "..", "..", "docs", "testing");
// The plan step clones the repository and makes the triage and plan calls.
const PLAN_TIMEOUT_MS = envInt("E2E_PLAN_TIMEOUT_MS", 600_000);
// Real builds are slower than the benchmark's: discovery, setup and checks.
const RUN_TIMEOUT_MS = envInt("E2E_REFERENCE_RUN_TIMEOUT_MS", 2_700_000);
const RUN_END_STATES = ["AWAITING_PUBLISH_APPROVAL", "BLOCKED", "FAILED", "CANCELED"];
const PUBLISH_TIMEOUT_MS = envInt("E2E_PUBLISH_TIMEOUT_MS", 300_000);
const DEFAULT_SUITE = "node";

const docker = (args, options = {}) =>
  execFileAsync("docker", args, { maxBuffer: 50_000_000, timeout: 900_000, ...options });

/** The benchmark instance a project is built from, downloaded once into scratch/. */
const loadInstance = async ({ source }) => {
  const file = path.join(CACHE_DIR, source.file.replace(/\//g, "__"));
  if (!fs.existsSync(file)) {
    const url = `https://huggingface.co/datasets/${source.dataset}/resolve/main/${source.file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not download ${url}: ${response.status}`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, await response.text());
  }
  const instance = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.number === source.number);
  if (!instance) throw new Error(`${source.file} has no instance ${source.number}`);
  return instance;
};

/** The project's tracked files at the base commit, read from the benchmark image (no network needed). */
const projectFiles = async (project, instance) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reference-"));
  const { stdout: container } = await docker(["create", project.grader.image]);
  try {
    // Only the git data: the working tree can hold build output with symlinks Windows can't create.
    await docker(["cp", `${container.trim()}:${project.grader.workdir}/.git`, path.join(dir, ".git")]);
    // "<mode> <type> <sha>\t<path>" at the base commit: the mode keeps executable scripts executable.
    const { stdout: listed } = await execFileAsync("git", ["-C", dir, "ls-tree", "-r", "-z", instance.base.sha], { maxBuffer: 50_000_000 });
    const files = new Map();
    for (const entry of listed.split("\0").filter(Boolean)) {
      const [info, file] = entry.split("\t");
      // The stored blob, not a checked-out file: git on Windows may convert line endings. Submodules are not blobs.
      const [mode, type, sha] = info.split(" ");
      if (type !== "blob") continue;
      const { stdout: content } = await execFileAsync("git", ["-C", dir, "cat-file", "blob", sha], { encoding: "buffer", maxBuffer: 50_000_000 });
      files.set(file, { mode, content });
    }
    return files;
  } finally {
    await docker(["rm", "-f", container.trim()]).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Replaces the sandbox repo's main with `files` ({ mode, content: Buffer }, so binary files survive). */
const pushProject = async (files, message, repo) => {
  const branch = env("E2E_GITHUB_DEFAULT_BRANCH", "main");
  const ref = await github("GET", `${repoPath(repo)}/git/ref/heads/${branch}`);
  const tree = [];
  // Text goes inline in the one tree request: a request per file trips
  // GitHub's secondary rate limit. Only binary files need a blob each.
  for (const [file, { mode, content }] of files) {
    // Pushing workflows needs the token's Workflows permission, and they would run the project's CI in the sandbox.
    if (file.startsWith(".github/workflows/")) continue;
    const text = content.toString("utf8");
    if (!text.includes("\0") && Buffer.from(text, "utf8").equals(content)) tree.push({ path: file, mode, type: "blob", content: text });
    else {
      const blob = await github("POST", `${repoPath(repo)}/git/blobs`, { content: content.toString("base64"), encoding: "base64" });
      tree.push({ path: file, mode, type: "blob", sha: blob.sha });
    }
  }
  const created = await github("POST", `${repoPath(repo)}/git/trees`, { tree });
  const commit = await github("POST", `${repoPath(repo)}/git/commits`, { message, tree: created.sha, parents: [ref.object.sha] });
  await github("PATCH", `${repoPath(repo)}/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha;
};

/**
 * Grades a diff as the benchmark does: in its image, without network, the
 * diff and then the instance's test patch applied, the tests run, and every
 * FAIL_TO_PASS and PASS_TO_PASS test class must pass. Results come from the
 * JUnit XML reports the test run leaves behind, or from the test log when
 * the project sets grader.resultPattern (a regex with name and status groups).
 */
const gradeDiff = async (project, instance, diff) => {
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "reference-patch-"));
  try {
    fs.writeFileSync(path.join(patchDir, "agent.diff"), diff);
    const { workdir, testPatch, test, resultPattern } = project.grader;
    const script = [
      `cd ${workdir}`,
      `git checkout -q --force ${instance.base.sha}`,
      "[ ! -s /patch/agent.diff ] || git apply --whitespace=nowarn /patch/agent.diff || { echo GRADE_APPLY_FAILED; exit 0; }",
      `git apply --whitespace=nowarn ${testPatch} || { echo GRADE_TEST_PATCH_FAILED; exit 0; }`,
      `${test.map((part) => `'${part}'`).join(" ")} > /tmp/test.log 2>&1; echo GRADE_EXIT=$?`,
      // One line per test suite report: its opening tag carries the name and the counts.
      resultPattern
        ? "echo GRADE_LOG_START; cat /tmp/test.log"
        : `grep -rl --include='*.xml' '<testsuite' . | while read -r f; do grep -o '<testsuite [^>]*>' "$f" | head -1; done; tail -c 3000 /tmp/test.log`,
    ].join("\n");
    const { stdout } = await docker(
      ["run", "--rm", "--network", "none", "--cpus", "2", "--memory", "3g", "-v", `${patchDir}:/patch:ro`, project.grader.image, "bash", "-c", script],
      { timeout: 1_800_000 },
    );
    if (stdout.includes("GRADE_APPLY_FAILED")) return { applied: false, output: stdout.slice(-1500) };
    if (stdout.includes("GRADE_TEST_PATCH_FAILED")) return { applied: false, output: `the hidden test patch no longer applies\n${stdout.slice(-1500)}` };
    const suites = new Map();
    if (resultPattern) {
      // Test names are not unique across packages: one failure anywhere fails the name.
      const pattern = new RegExp(resultPattern);
      for (const line of stdout.slice(stdout.indexOf("GRADE_LOG_START")).split("\n")) {
        const groups = pattern.exec(line)?.groups;
        // Runners word a pass differently: PASS (go, jest, automake), ok (cargo), Passed (ctest), Success (CMake checks).
        // The benchmark lower-cases some projects' names (Catch2), so names are compared without case.
        const name = groups?.name.toLowerCase();
        if (groups && suites.get(name) !== "FAIL") suites.set(name, /^(PASS|ok|Passed|Success)$/.test(groups.status) ? "PASS" : "FAIL");
      }
    }
    for (const tag of stdout.match(/<testsuite [^>]*>/g) ?? []) {
      const attribute = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
      const failed = Number(attribute("failures") ?? 0) + Number(attribute("errors") ?? 0) > 0;
      suites.set(attribute("name")?.toLowerCase(), failed ? "FAIL" : "PASS");
    }
    // The benchmark cuts some subtest names short ("a/b" for "a/b/c"); a parent fails when a subtest does.
    // Jest names are "file:test" but the log reports per file; a test passes with its file.
    const status = (test) => {
      const name = test.toLowerCase();
      return suites.get(name) ?? suites.get(name.split("/")[0]) ?? suites.get(name.split(":")[0]) ?? "MISSING";
    };
    const failing = (names) => names.filter((name) => status(name) !== "PASS").map((name) => `${name} (${status(name)})`);
    // Tests that cannot pass in the offline grader (e.g. they need a network interface), per project.
    const graded = (tests) => Object.keys(tests).filter((name) => !(project.grader.skip ?? []).includes(name.split("/")[0]));
    const failToPass = failing(graded(instance.f2p_tests));
    const passToPass = failing(graded(instance.p2p_tests));
    return { applied: true, failToPass, passToPass, passed: !failToPass.length && !passToPass.length, output: stdout.slice(-1500) };
  } finally {
    fs.rmSync(patchDir, { recursive: true, force: true });
  }
};

// Each sandbox repository's own policy, put back after the projects ran.
const ORIGINAL_POLICY = (fixtures) => (fixtures.originalPolicy ??= fixtures.repository.executionPolicy ?? {});

/** Sets the sandbox repository's execution policy (limits such as the setup timeout), if it differs. */
const usePolicy = async (fixtures, executionPolicy) => {
  if (JSON.stringify(fixtures.repository.executionPolicy) === JSON.stringify(executionPolicy)) return;
  const { data } = await api("PATCH", `/api/repositories/${fixtures.repository.id}`, { body: { executionPolicy }, expectStatus: 200 });
  fixtures.repository = data;
};

/** A project's ticket written in place of its GitHub issue: "# title", a blank line, the body. */
const loadTicket = (project, name) => {
  const file = path.join(TICKETS_DIR, `${project.id.replace(/\//g, "__")}.${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`--ticket ${name}: no ${path.relative(process.cwd(), file)}`);
  const [first, ...rest] = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  if (!first.startsWith("# ")) throw new Error(`${file} must start with "# <title>"`);
  return { title: first.slice(2).trim(), body: rest.join("\n").trim() };
};

const runProject = async (fixtures, project, publish, ticket) => {
  const id = runId();
  const started = Date.now();
  const result = { project: project.id, language: project.language, outcome: "infra_failure", note: "" };
  let cardId;
  try {
    const instance = await loadInstance(project);
    const issue = { ...instance.resolved_issues[0], ...(ticket && loadTicket(project, ticket)) };
    result.issue = `${instance.org}/${instance.repo}#${issue.number}${ticket ? ` (${ticket})` : ""}`;
    log(`${project.id}: ${result.issue} "${issue.title}"`);
    await docker(["pull", "-q", project.grader.image]);
    const files = await projectFiles(project, instance);
    // The environment a person approved once, if the project has one; else none,
    // and discovery has to find out how the project is built and tested.
    await useEnvironment(fixtures, project.environment ?? {});
    await usePolicy(fixtures, { ...ORIGINAL_POLICY(fixtures), ...project.executionPolicy });
    // The sandbox repository held another project before: discovery would first
    // retry the environment that project's run stored. Runs of the same project keep it.
    if (fixtures.lastProject !== project.id) {
      const { data } = await api("PATCH", `/api/repositories/${fixtures.repository.id}`, { body: { environmentProposal: null }, expectStatus: 200 });
      fixtures.repository = data;
      fixtures.lastProject = project.id;
    }
    log(`${project.id}: pushing ${files.size} files at ${instance.base.sha.slice(0, 8)}`);
    const baseSha = await pushProject(files, `reference: ${project.id} at ${instance.base.sha} (${id})`, fixtures.repo);
    cardId = await createCard(`[${id}] ${issue.title}`, issue.body ?? "", fixtures.label);
    const workItem = await ingestCard(fixtures, cardId);
    const { data: detail } = await api("GET", `/api/work-items/${workItem.id}`, { expectStatus: 200 });
    result.executionId = detail.executions[0].id;
    log(`${project.id}: execution ${result.executionId}`);

    await approvePlan(result.executionId, PLAN_TIMEOUT_MS);
    const execution = await waitForAnyStatus(result.executionId, RUN_END_STATES, RUN_TIMEOUT_MS);
    Object.assign(result, eventMetrics(execution.events), usageMetrics(execution.usage));
    if (execution.baseSha && execution.baseSha !== baseSha) throw new Error(`run used base ${execution.baseSha}, expected ${baseSha}`);
    const event = (type) => execution.events.find((candidate) => candidate.type === type)?.payload;
    result.environment = event("GRAPH_TOOLCHAIN_RESOLVED");
    result.discovery = event("GRAPH_ENVIRONMENT_DISCOVERED");
    result.baseline = event("GRAPH_BASELINE_CHECKED");
    result.failingBefore = event("GRAPH_VERIFICATION_PASSED")?.failingBefore;

    if (execution.status === "AWAITING_PUBLISH_APPROVAL") {
      const artifact = execution.artifacts.find((candidate) => candidate.type === "DIFF");
      const diff = fs.readFileSync(artifactPath(artifact), "utf8");
      // Same formula as hashSnapshot in src/services/executionService.ts.
      if (crypto.createHash("sha256").update(JSON.stringify(diff)).digest("hex") !== artifact.sha256)
        throw new Error("diff artifact does not match its recorded sha256");
      await api("POST", `/api/executions/${result.executionId}/approvals/publish`, {
        body: { approved: publish, snapshotHash: pendingApproval(execution, "PUBLISH").snapshotHash, comment: "reference eval" },
        expectStatus: 200,
      });
      if (publish) {
        const published = await waitForStatus(result.executionId, "COMPLETED", PUBLISH_TIMEOUT_MS);
        result.pullRequest = published.artifacts.find((candidate) => candidate.type === "PULL_REQUEST")?.metadata?.html_url;
        if (!result.pullRequest) throw new Error("published, but no PULL_REQUEST artifact");
        log(`${project.id}: draft PR ${result.pullRequest}`);
      }
      const stats = diffStats(diff);
      result.files = stats.files;
      result.linesAdded = stats.added;
      result.linesRemoved = stats.removed;
      const objections = artifact.metadata?.reviewObjections ?? [];
      const graded = await gradeDiff(project, instance, diff);
      result.gradeOutput = graded.output;
      if (!graded.applied) result.note = `diff did not apply: ${graded.output.trim().slice(0, 300)}`;
      else if (graded.passed) result.outcome = "correct_fix";
      else {
        result.outcome = objections.length ? "wrong_fix_flagged" : "wrong_fix_shipped";
        result.note = [
          graded.failToPass.length ? `FAIL_TO_PASS still failing: ${graded.failToPass.join(", ")}` : "",
          graded.passToPass.length ? `PASS_TO_PASS broken: ${graded.passToPass.slice(0, 5).join(", ")}${graded.passToPass.length > 5 ? ", ..." : ""}` : "",
        ].filter(Boolean).join("; ");
      }
      if (objections.length) result.note = [result.note, `reviewer objected: ${objections.join(" / ").slice(0, 200)}`].filter(Boolean).join("; ");
    } else if (execution.status === "BLOCKED") {
      result.outcome = "no_fix";
      result.note = (execution.lastError ?? "").replace(/\s+/g, " ").slice(0, 300);
    } else {
      result.note = `${execution.status}: ${(execution.lastError ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
    }
  } catch (error) {
    result.outcome = "infra_failure";
    result.note = error.message.replace(/\s+/g, " ").slice(0, 300);
  } finally {
    result.durationMs = Date.now() - started;
    if (cardId && env("E2E_KEEP_RESOURCES") !== "true")
      await trello("DELETE", `/cards/${cardId}`).catch((error) => log(`could not delete card: ${error.message}`));
  }
  log(`${project.id}: ${OUTCOMES[result.outcome]}${result.note ? ` (${result.note})` : ""}`);
  return result;
};

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const writeReport = (results, meta) => {
  const lines = [
    `# Reference projects ${meta.date}`,
    "",
    "Generated by `npm run eval:reference` (tests/e2e/referenceEval.js). Projects: `tests/e2e/reference-projects/projects.json`, instances from Multi-SWE-bench, graded by its FAIL_TO_PASS and PASS_TO_PASS tests in its own image.",
    "",
    `Model: ${env("E2E_LLM_PROVIDER")} / ${env("E2E_LLM_MODEL")}. Code version: ${meta.commit}. Ticket: ${meta.ticket ? `\`${meta.ticket}\` (reference-projects/tickets/)` : "the GitHub issue"}.`,
    "",
    ...(results.length > new Set(results.map((result) => result.project)).size
      ? [
          "| Project | Runs | Outcomes |",
          "| --- | --- | --- |",
          ...[...new Set(results.map((result) => result.project))].map((project) => {
            const runs = results.filter((result) => result.project === project);
            const counts = Object.entries(Object.groupBy(runs, (result) => OUTCOMES[result.outcome])).map(([outcome, list]) => `${outcome} ${list.length}`);
            return `| ${project} | ${runs.length} | ${counts.join(", ")} |`;
          }),
          "",
        ]
      : []),
    "| Project | Issue | Outcome | Attempts | LLM calls | Tokens | Cost | Duration | Files changed | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => {
      const tokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
      return `| ${result.project} | ${result.issue ?? ""} | ${OUTCOMES[result.outcome]} | ${result.attempts ?? ""} | ${result.llmCalls ?? ""} | ${tokens ? `${Math.round(tokens / 1000)}k` : ""} | ${result.costUsd === undefined ? "" : `$${result.costUsd.toFixed(3)}`} | ${Math.round(result.durationMs / 1000)}s | ${cell((result.files ?? []).join(", "))} | ${cell([result.pullRequest && `draft PR ${result.pullRequest}`, result.note].filter(Boolean).join("; "))} |`;
    }),
    "",
    "## Environment per project",
    "",
    ...results.flatMap((result) => [
      `### ${result.project}`,
      "",
      "```json",
      JSON.stringify({ environment: result.environment, discovery: result.discovery, baseline: result.baseline, failingBefore: result.failingBefore }, null, 2).slice(0, 6000),
      "```",
      "",
      ...(result.gradeOutput ? ["Grading output (end):", "", "```text", result.gradeOutput.trim(), "```", ""] : []),
    ]),
  ];
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  let file = path.join(REPORT_DIR, `reference-${meta.date}.md`);
  for (let index = 2; fs.existsSync(file); index += 1) file = path.join(REPORT_DIR, `reference-${meta.date}-${index}.md`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

const main = async () => {
  const args = process.argv.slice(2);
  const valueAt = (name) => (args.includes(name) ? args.indexOf(name) + 1 : -1);
  const number = (name) => {
    if (valueAt(name) < 0) return 1;
    const value = Number.parseInt(args[valueAt(name)], 10);
    if (!(value >= 1)) throw new Error(`${name} must be a positive number`);
    return value;
  };
  const parallel = number("--parallel");
  const runs = number("--runs");
  const ticket = valueAt("--ticket") >= 0 ? args[valueAt("--ticket")] : undefined;
  if (valueAt("--ticket") >= 0 && !ticket) throw new Error("--ticket needs a name");
  const values = ["--parallel", "--runs", "--ticket"].map(valueAt);
  const wanted = args.filter((arg, index) => !arg.startsWith("--") && !values.includes(index));
  const check = process.argv.includes("--check");
  const publish = process.argv.includes("--publish");
  const missing = skipUnless([...PIPELINE_ENV, "E2E_GITHUB_TOKEN"]);
  if (missing) throw new Error(missing);
  let projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  if (wanted.length) projects = projects.filter((project) => wanted.some((id) => project.id.startsWith(id)));
  if (!projects.length) throw new Error(`No reference project matches ${wanted.join(", ")}`);
  // Each project replaces main, which would turn an earlier project's PR into a diff against another project.
  if (publish && (projects.length > 1 || runs > 1)) throw new Error("--publish runs one project once; name it (e.g. go/go-zero-1969)");
  // Fail before any run when a ticket file is missing or malformed.
  if (ticket) projects.forEach((project) => loadTicket(project, ticket));
  projects = projects.flatMap((project) => Array(runs).fill(project));

  await assertServerHealthy();
  // One sandbox repository and card label per parallel slot; the first is the usual one.
  const repos = [env("E2E_GITHUB_REPO"), ...env("E2E_GITHUB_EXTRA_REPOS", "").split(",").map((repo) => repo.trim()).filter(Boolean)];
  if (parallel > repos.length) throw new Error(`--parallel ${parallel} needs ${parallel - 1} repositories in E2E_GITHUB_EXTRA_REPOS`);
  const slots = [];
  // In turn: each call also refreshes the shared project and agent.
  for (const [index, repo] of repos.slice(0, Math.min(parallel, projects.length)).entries())
    slots.push(await ensureFixtures({ repo, label: index ? `${env("E2E_TRELLO_LABEL")}-${index + 1}` : env("E2E_TRELLO_LABEL") }));
  if (check) {
    // No model calls: the instances load, the images run, and the known fix grades as correct.
    for (const project of projects) {
      const instance = await loadInstance(project);
      await docker(["pull", "-q", project.grader.image]);
      const files = await projectFiles(project, instance);
      const fix = await gradeDiff(project, instance, instance.fix_patch);
      const none = await gradeDiff(project, instance, "");
      log(`${project.id}: ${files.size} files; known fix ${fix.passed ? "passes" : `FAILS (${[...(fix.failToPass ?? []), ...(fix.passToPass ?? [])].join(", ") || fix.output})`}; unchanged code ${none.passed ? "PASSES (instance is not valid)" : `fails as expected (${none.failToPass.join(", ")})`}`);
    }
    return;
  }
  const { stdout: commit } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "unknown" }));
  log(`${projects.length} project(s) with ${env("E2E_LLM_PROVIDER")}/${env("E2E_LLM_MODEL")}${env("E2E_PRICE_PER_MTOK") ? "" : " (set E2E_PRICE_PER_MTOK for cost)"}`);
  const results = new Array(projects.length);
  let next = 0;
  try {
    // Each slot takes the next project when its run ends; results keep the project order.
    await Promise.all(
      slots.map(async (fixtures) => {
        while (next < projects.length) {
          const index = next++;
          results[index] = await runProject(fixtures, projects[index], publish, ticket);
        }
      }),
    );
  } finally {
    const suite = loadSuites().find((candidate) => candidate.name === DEFAULT_SUITE);
    for (const fixtures of slots) {
      if (publish) log("--publish: main left at the project so the draft PR stays readable");
      else
        await setDefaultBranch(cleanFiles(suite), "reference: restore clean project", fixtures.repo).catch((error) => log(`could not restore ${fixtures.repo} main: ${error.message}`));
      await useEnvironment(fixtures, suiteEnvironment(suite)).catch((error) => log(`could not restore ${fixtures.repo}'s environment: ${error.message}`));
      await usePolicy(fixtures, ORIGINAL_POLICY(fixtures)).catch((error) => log(`could not restore ${fixtures.repo}'s policy: ${error.message}`));
    }
  }
  const file = writeReport(results, { date: new Date().toLocaleDateString("sv"), commit: commit.trim(), ticket });
  log(`report: ${path.relative(process.cwd(), file)}`);
};

if (require.main === module)
  main().catch((error) => {
    console.error(`[reference] ${error.stack}`);
    process.exitCode = 1;
  });

module.exports = { gradeDiff, loadInstance, loadTicket, projectFiles, writeReport };
