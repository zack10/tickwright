/**
 * Reviewer benchmark: replays diffs the pipeline already approved (DIFF
 * artifacts from coding-eval runs) through the code-reading reviewer alone.
 * Each diff is graded with its scenario's hidden tests, so the result says
 * how many wrong fixes the reviewer catches and how many correct ones it
 * rejects, without running the agent again.
 *
 *   npm run build && npm run eval:reviewer -- [--scenario go/03] [--limit N] [--since 2026-10-29]
 *     [--artifact ID] [--trace] [--grade-only: grade the diffs, call no model]
 *     [--provider openai --model gpt-5-mini --key-env E2E_LLM_API_KEY] [--concurrency 3]
 *
 * Reads the database from .env.local and the model key from .env.e2e. Grades
 * are cached in scratch/reviewer-eval-grades.json (they need Docker).
 */
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const prisma = require("../../dist/db").default;
const { renderExecutionPrompt } = require("../../dist/prompts");
const { LLMService } = require("../../dist/services/llm/LLMService");
const { REVIEW_MAX_TOKENS, runReviewer } = require("../../dist/services/agentGraph/reviewer");
const { diffStats, grade, isTestFile, loadScenarios, scenarioFiles, writeTree } = require("./codingScenarios");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..", "..");
const GRADE_CACHE = path.join(ROOT, "scratch", "reviewer-eval-grades.json");
const REPORT_DIR = path.join(ROOT, "docs", "testing");
const REVIEW_TIMEOUT_MS = 10 * 60_000;
const TITLE = /^\[[^\]]+\] (.*)$/;

const parseArgs = (argv) => {
  const options = { concurrency: 3, keyEnv: "E2E_LLM_API_KEY" };
  for (let index = 0; index < argv.length; index++) {
    const [name, value] = [argv[index].replace(/^--/, ""), argv[index + 1]];
    if (name === "trace" || name === "grade-only") {
      options[name === "trace" ? "trace" : "gradeOnly"] = true;
      continue;
    }
    if (["scenario", "since", "provider", "model", "artifact"].includes(name)) options[name] = value;
    else if (name === "key-env") options.keyEnv = value;
    else if (["limit", "concurrency"].includes(name)) options[name] = Number(value);
    else throw new Error(`unknown option ${argv[index]}`);
    index++;
  }
  options.provider ??= process.env.E2E_LLM_PROVIDER;
  options.model ??= process.env.E2E_LLM_MODEL;
  return options;
};

const log = (message) => console.log(`[review-eval ${new Date().toISOString().slice(11, 19)}] ${message}`);

const readCache = () => {
  try {
    return JSON.parse(fs.readFileSync(GRADE_CACHE, "utf8"));
  } catch {
    return {};
  }
};

/** Approved diffs, each matched to the scenario its ticket came from. */
const loadCases = async (options) => {
  const scenarios = new Map(loadScenarios().map((scenario) => [scenario.title, scenario]));
  const artifacts = await prisma.artifact.findMany({
    where: { type: "DIFF", ...(options.since ? { createdAt: { gte: new Date(options.since) } } : {}) },
    include: { execution: { include: { workItem: true, events: { where: { type: "GRAPH_INTERNAL_PLAN_CREATED" } } } } },
    orderBy: { createdAt: "asc" },
  });
  const cases = [];
  for (const artifact of artifacts) {
    const { workItem, events } = artifact.execution;
    const scenario = scenarios.get(TITLE.exec(workItem.title)?.[1]);
    if (!scenario || (options.scenario && !scenario.id.startsWith(options.scenario))) continue;
    if (options.artifact && !artifact.id.startsWith(options.artifact)) continue;
    if (!fs.existsSync(artifact.storagePath)) continue;
    const diff = fs.readFileSync(artifact.storagePath, "utf8");
    // Same formula as hashSnapshot in src/services/executionService.ts.
    if (crypto.createHash("sha256").update(JSON.stringify(diff)).digest("hex") !== artifact.sha256) continue;
    const internalPlan = events.at(-1)?.payload?.internalPlan;
    cases.push({
      id: artifact.id,
      createdAt: artifact.createdAt,
      scenario,
      diff,
      ticket: `${workItem.title}\n${workItem.description ?? ""}`,
      internalPlan: typeof internalPlan === "string" ? internalPlan : JSON.stringify(internalPlan ?? ""),
    });
  }
  return options.limit ? cases.slice(-options.limit) : cases;
};

/** correct, wrong, or unusable (the diff no longer applies to the scenario). */
const gradeCase = async (testCase, cache) => {
  const cached = cache[testCase.id];
  if (cached) return cached;
  let result;
  if (testCase.scenario.expect === "blocked") result = { grade: "wrong", note: "fix for an impossible ticket" };
  else {
    const graded = await grade(testCase.scenario.suite, scenarioFiles(testCase.scenario), testCase.scenario.hiddenFiles, testCase.diff);
    result = !graded.applied
      ? { grade: "unusable", note: "diff does not apply to the current scenario" }
      : graded.visiblePassed && graded.hiddenPassed
        ? { grade: "correct" }
        : { grade: "wrong", note: graded.hiddenPassed ? "repo tests failed" : "hidden test failed" };
  }
  cache[testCase.id] = result;
  fs.mkdirSync(path.dirname(GRADE_CACHE), { recursive: true });
  fs.writeFileSync(GRADE_CACHE, JSON.stringify(cache, null, 2));
  return result;
};

const git = (cwd, ...args) => execFileAsync("git", ["-c", "core.autocrlf=false", ...args], { cwd });

/** The scenario's repository with the diff applied, as the reviewer saw it. */
const workspaceFor = async (testCase) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-eval-"));
  const files = scenarioFiles(testCase.scenario);
  writeTree(root, files);
  await git(root, "init", "-q");
  await git(root, "add", "-A");
  await git(root, "-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "base");
  fs.writeFileSync(path.join(root, ".git", "changes.diff"), testCase.diff);
  await git(root, "apply", "--whitespace=nowarn", ".git/changes.diff");
  const suite = testCase.scenario.suite;
  const noSandbox = async () => {
    throw new Error("the reviewer cannot run commands");
  };
  return {
    root,
    protectedPaths: [],
    checkScripts: [],
    runCheck: noSandbox,
    runCommand: noSandbox,
    isTestFile: (file) => isTestFile(suite, file),
    isBaseFile: (file) => files.has(file),
    reproduction: { shown: false, newTest: false },
  };
};

const noRecorder = { create: async () => "", update: async () => {} };

const reviewCase = async (testCase, options, llm) => {
  const ctx = await workspaceFor(testCase);
  const usage = { inputTokens: 0, outputTokens: 0, steps: 0 };
  try {
    const prompt = renderExecutionPrompt("reviewer", {
      ticket: testCase.ticket,
      internalPlan: testCase.internalPlan,
      changedFiles: diffStats(testCase.diff).files.join("\n"),
      diff: testCase.diff.slice(0, 80_000),
      reproduction: "Not recorded for this replayed change.",
    });
    const verdict = await runReviewer(ctx, prompt, {
      generate: (request) =>
        llm.generateWithTools(options.provider, options.model, request, process.env[options.keyEnv], { purpose: prompt.version }),
      recorder: noRecorder,
      maxTokens: REVIEW_MAX_TOKENS,
      deadline: Date.now() + REVIEW_TIMEOUT_MS,
      onStep: async (step) => {
        if (options.trace)
          for (const { call, outcome } of step.toolCalls)
            console.log(`--- step ${step.step} ${call.name} ${JSON.stringify(call.arguments)}
${step.text ? `[text] ${step.text}
` : ""}${outcome.output.slice(0, 1500)}`);
        usage.steps = step.step;
        usage.inputTokens += step.usage?.inputTokens ?? 0;
        usage.outputTokens += step.usage?.outputTokens ?? 0;
      },
    });
    return { verdict, usage, promptVersion: prompt.version };
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
};

/** Runs `work` over `items`, `limit` at a time. */
const pool = async (items, limit, work) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index], index);
      }
    }),
  );
  return results;
};

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 300);
const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "n/a");

const writeReport = (results, options, promptVersion, durationMs) => {
  const scored = results.filter((result) => result.grade !== "unusable" && !result.error);
  const wrong = scored.filter((result) => result.grade === "wrong");
  const correct = scored.filter((result) => result.grade === "correct");
  const caught = wrong.filter((result) => !result.verdict.approved);
  const rejected = correct.filter((result) => !result.verdict.approved);
  const tokens = scored.reduce((sum, result) => sum + result.usage.inputTokens + result.usage.outputTokens, 0);
  const date = new Date().toISOString().slice(0, 10);
  let file = path.join(REPORT_DIR, `reviewer-eval-${date}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(REPORT_DIR, `reviewer-eval-${date}-${n}.md`);
  const lines = [
    `# Reviewer evaluation ${date}`,
    "",
    "Generated by `npm run eval:reviewer` (tests/e2e/reviewerEval.js): diffs the pipeline approved during coding-eval runs, graded with the scenario's hidden tests and reviewed again by the code-reading reviewer alone.",
    "",
    "| | |",
    "| --- | --- |",
    `| Reviewer | ${options.provider} / ${options.model} |`,
    `| Prompt version | ${promptVersion} |`,
    `| Diffs | ${results.length} (${scored.length} scored; ${results.length - scored.length} unusable or failed) |`,
    `| Duration | ${Math.round(durationMs / 60_000)} min |`,
    `| Tokens | ${tokens} (avg ${scored.length ? Math.round(tokens / scored.length) : 0} per review) |`,
    "",
    "## Summary",
    "",
    "| Wrong fixes | Caught (rejected) | Correct fixes | Rejected | Catch rate | False-rejection rate |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${wrong.length} | ${caught.length} | ${correct.length} | ${rejected.length} | ${percent(caught.length, wrong.length)} | ${percent(rejected.length, correct.length)} |`,
    "",
    "## Diffs",
    "",
    "| Scenario | Artifact | Grade | Verdict | Steps | Tokens | Issues / checks that said no | Suggestions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => {
      const noChecks = Object.entries(result.verdict?.checks ?? {})
        .filter(([, answer]) => /^no\b/i.test(String(answer?.answer ?? answer)))
        .map(([name, answer]) => `${name}: ${answer?.evidence ?? ""}`);
      return `| ${result.scenario} | ${result.id.slice(0, 8)} | ${result.grade}${result.note ? ` (${result.note})` : ""} | ${
        result.error ? `error: ${cell(result.error)}` : result.verdict ? (result.verdict.approved ? "approved" : "rejected") : "not reviewed"
      } | ${result.usage?.steps ?? ""} | ${result.usage ? result.usage.inputTokens + result.usage.outputTokens : ""} | ${cell(
        [...(result.verdict?.issues ?? []), ...noChecks].join(" / "),
      )} | ${cell((result.verdict?.suggestions ?? []).join(" / "))} |`;
    }),
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"));
  return { file, wrong: wrong.length, caught: caught.length, correct: correct.length, rejected: rejected.length };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.gradeOnly && (!options.provider || !options.model || !process.env[options.keyEnv]))
    throw new Error(`set --provider, --model and ${options.keyEnv} (E2E_LLM_* in .env.e2e)`);
  const started = Date.now();
  const cases = await loadCases(options);
  log(`${cases.length} approved diff(s); grading`);
  const cache = readCache();
  const grades = await pool(cases, options.concurrency, (testCase) => gradeCase(testCase, cache));
  const counts = grades.reduce((sum, { grade: value }) => ({ ...sum, [value]: (sum[value] ?? 0) + 1 }), {});
  log(`grades: ${JSON.stringify(counts)}`);
  if (options.gradeOnly) {
    for (const [index, testCase] of cases.entries())
      if (grades[index].grade !== "correct") log(`${testCase.scenario.id} ${testCase.id.slice(0, 8)}: ${grades[index].grade} (${grades[index].note})`);
    return;
  }
  log(`reviewing with ${options.provider}/${options.model}`);

  const llm = new LLMService();
  let promptVersion = "";
  const results = await pool(cases, options.concurrency, async (testCase, index) => {
    const result = { id: testCase.id, scenario: testCase.scenario.id, ...grades[index] };
    if (result.grade === "unusable") return result;
    try {
      const reviewed = await reviewCase(testCase, options, llm);
      promptVersion = reviewed.promptVersion;
      Object.assign(result, reviewed);
      const expected = result.grade === "correct" ? "approved" : "rejected";
      const actual = reviewed.verdict.approved ? "approved" : "rejected";
      log(`${result.scenario} ${result.id.slice(0, 8)}: ${result.grade}, ${actual}${actual === expected ? "" : "  <-- mismatch"}`);
    } catch (error) {
      result.error = error.message;
      log(`${result.scenario} ${result.id.slice(0, 8)}: review failed: ${error.message}`);
    }
    return result;
  });
  const report = writeReport(results, options, promptVersion, Date.now() - started);
  log(`wrong fixes caught ${report.caught}/${report.wrong}; correct fixes rejected ${report.rejected}/${report.correct}`);
  log(`report: ${path.relative(ROOT, report.file)}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
