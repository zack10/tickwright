// Turns a pull request of the agent's that a person corrected and merged
// into a benchmark case (roadmap Phase 7, step 9): the ticket as the agent
// got it, the base commit, the merged change split into the fix and its
// tests (the hidden tests), and what the agent published. Read-only and
// free; reads the production database and artifacts through `docker exec`,
// as npm run trace does. Run the case with
// `npm run eval:reference -- case/<folder>` (--check proves it first).
//
//   npm run case:from-pr -- <execution id>
//
// Cases go to scratch/pr-cases/ (gitignored): they hold the repository's code.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const { isTestFile, parseVerificationConfig, DEFAULT_TEST_FILE_PATTERNS } = require("../dist/services/toolchain");
const { query, rows } = require("./trace");

const APP = process.env.TRACE_APP_CONTAINER || "agent-orchestration-prod-app-1";
const CASES_DIR = path.resolve(__dirname, "..", "scratch", "pr-cases");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);

/** A unified diff cut into the test files' part and the rest, by the repository's test-file patterns. */
const splitDiff = (diff, isTest) => {
  const parts = { fix: "", hidden: "", testFiles: [] };
  for (const chunk of diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "))) {
    const file = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk)[1];
    if (isTest(file)) {
      parts.hidden += chunk;
      parts.testFiles.push(file);
    } else parts.fix += chunk;
  }
  return parts;
};

/** Why an outcome gives no case, or undefined when it does. */
const outcomeProblem = (outcome) => {
  if (!outcome) return "its pull request has no recorded outcome yet (still open, or not polled since it closed)";
  if (outcome.state !== "MERGED") return `its pull request was ${outcome.state.toLowerCase()}, not merged: no correct change was recorded`;
  if (outcome.mergedAsWritten === true) return "its pull request was merged as written: nothing was corrected";
};

const readArtifact = async (storagePath) =>
  (await execFileAsync("docker", ["exec", APP, "cat", storagePath], { maxBuffer: 100_000_000 })).stdout;

const main = async () => {
  const id = process.argv[2];
  if (!UUID.test(id ?? "")) throw new Error("usage: npm run case:from-pr -- <execution id>");
  const [execution] = await query(rows(`
    select e.id, e."baseSha", e."parentExecutionId", w.title, w.description, w."sourceUrl",
      r.provider, r.owner, r.name, r."verificationConfig", r."executionPolicy"
    from "Execution" e join "WorkItem" w on w.id = e."workItemId" join "Repository" r on r.id = e."repositoryId"
    where e.id = '${id}'`));
  if (!execution) throw new Error(`no execution ${id}`);
  if (execution.parentExecutionId) throw new Error(`${id} is a follow-up round; give its first execution, ${execution.parentExecutionId}`);
  // shortcut: GitHub only, as the evals' sandbox; a clone URL from the source-control adapter when Phase 5 adds hosts.
  if (execution.provider !== "GITHUB") throw new Error(`repositories on ${execution.provider} are not supported yet (Phase 5)`);
  const [event] = await query(rows(`select payload from "ExecutionEvent" where "executionId" = '${id}' and type = 'PULL_REQUEST_OUTCOME'`));
  const problem = outcomeProblem(event?.payload);
  if (problem) throw new Error(`no case from ${id}: ${problem}`);

  // The root's and every completed round's newest DIFF: what publish approval pushed, in order.
  const artifacts = await query(rows(`
    select distinct on (a."executionId", a.type) a.type, a."storagePath", e."createdAt"
    from "Artifact" a join "Execution" e on e.id = a."executionId"
    where a.type in ('DIFF', 'MERGED_DIFF') and (e.id = '${id}' or (e."parentExecutionId" = '${id}' and e.status = 'COMPLETED'))
    order by a."executionId", a.type, a."createdAt" desc`));
  const merged = artifacts.find((artifact) => artifact.type === "MERGED_DIFF");
  if (!merged) throw new Error(`no case from ${id}: the merged diff was not stored (too large for the host to render?)`);
  const published = artifacts.filter((artifact) => artifact.type === "DIFF").sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const { toolchain } = parseVerificationConfig(execution.verificationConfig);
  const patterns = toolchain?.testFilePatterns ?? DEFAULT_TEST_FILE_PATTERNS;
  const { fix, hidden, testFiles } = splitDiff(await readArtifact(merged.storagePath), (file) => isTestFile({ testFilePatterns: patterns }, file));
  if (!hidden) throw new Error(`no case from ${id}: the merged change has no test file (patterns: ${patterns.join(", ")}); add a test that fails on the agent's change`);

  const pullRequest = event.payload.pullRequest;
  const folder = `${execution.owner}-${execution.name}-${pullRequest}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.join(CASES_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const agentPatches = [];
  for (const [index, artifact] of published.entries()) {
    const name = `agent.${index + 1}.patch`;
    fs.writeFileSync(path.join(dir, name), await readArtifact(artifact.storagePath));
    agentPatches.push(name);
  }
  fs.writeFileSync(path.join(dir, "ticket.md"), `# ${execution.title}\n\n${execution.description ?? ""}\n`);
  fs.writeFileSync(path.join(dir, "fix.patch"), fix);
  fs.writeFileSync(path.join(dir, "hidden.patch"), hidden);
  const ticketCase = {
    executionId: id,
    repository: `${execution.owner}/${execution.name}`,
    cloneUrl: `https://github.com/${execution.owner}/${execution.name}.git`,
    baseSha: execution.baseSha,
    pullRequest,
    ticketUrl: execution.sourceUrl,
    filesChangedByPerson: event.payload.filesChangedByPerson,
    hiddenTestFiles: testFiles,
    agentPatches,
    // The environment the run had; a project's devcontainer is read again from the base files.
    environment: execution.verificationConfig,
    executionPolicy: execution.executionPolicy,
  };
  fs.writeFileSync(path.join(dir, "case.json"), `${JSON.stringify(ticketCase, null, 2)}\n`);
  console.log(`case written to ${path.relative(process.cwd(), dir)}: ${testFiles.length} hidden test file(s), ${agentPatches.length} agent patch(es)`);
  console.log(`prove it (free): npm run eval:reference -- case/${folder} --check`);
};

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { outcomeProblem, splitDiff };
