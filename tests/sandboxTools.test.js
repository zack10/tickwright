const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PLAN_TOOLS, REVIEW_TOOLS, SANDBOX_TOOLS, agentTestCheck, describeReproduction, executeTool } = require("../dist/services/sandbox/tools");
const { runPlanner } = require("../dist/services/agentGraph/planner");
const { json, runRecordedTool } = require("../dist/services/sandbox/toolRunner");
const { fsRepoFiles, isTestFile, resolveToolchain } = require("../dist/services/toolchain");

/** A throwaway repository: src, an existing test, a protected file, git metadata. */
const workspace = (t, overrides = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": '{ "scripts": { "test": "node --test" } }\n',
    "src/math.js": "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n",
    "src/dup.js": "x = 1;\nx = 1;\n",
    "tests/math.test.js": "// existing test\n",
    "node_modules/lib/index.js": "ignored\n",
    ".git/config": "[core]\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const checks = [];
  const commands = [];
  const { toolchain } = resolveToolchain(fsRepoFiles(root), {});
  // Tracked at the base commit: everything but node_modules and .git.
  const baseFiles = new Set(Object.keys(files).filter((file) => !/^(node_modules|\.git)\//.test(file)));
  const ctx = {
    root,
    protectedPaths: ["package.json", "package-lock.json", ".github"],
    checkScripts: ["test"],
    runCheck: async (check) => {
      checks.push(check);
      return { exitCode: 1, timedOut: false, output: "1 failing: expected 3, got -1" };
    },
    runCommand: async (command, timeoutMs) => {
      commands.push({ command, timeoutMs });
      return { exitCode: 0, timedOut: false, output: "ok" };
    },
    isTestFile: (file) => isTestFile(toolchain, file),
    isBaseFile: (file) => baseFiles.has(file),
    // Most tests are about other rules: the problem counts as already shown.
    reproduction: { shown: true, newTest: false },
    ...overrides,
  };
  return { root, ctx, checks, commands };
};

const run = (ctx, name, args) => executeTool(ctx, name, args);

test("every tool definition has a name, description and object schema", () => {
  assert.deepEqual(
    SANDBOX_TOOLS.map((tool) => tool.name),
    ["list_files", "read_file", "search_code", "edit_file", "run_check", "run_command", "skip_reproduction", "finish"],
  );
  for (const tool of SANDBOX_TOOLS) {
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.parameters.type, "object", tool.name);
  }
});

test("list_files skips node_modules and .git", async (t) => {
  const { ctx } = workspace(t);
  const result = await run(ctx, "list_files", {});
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.output.split("\n"), ["package.json", "src/dup.js", "src/math.js", "tests/math.test.js"]);
});

test("read_file returns numbered line ranges and says how to continue", async (t) => {
  const { root, ctx } = workspace(t);
  const whole = await run(ctx, "read_file", { path: "src/math.js" });
  assert.match(whole.output, /^src\/math.js \(lines 1-5 of 5\)\n1\tfunction add\(a, b\) \{\n2\t  return a - b;/);
  // What a model copies after the tab is the line exactly as the file has it.
  const copied = whole.output.split("\n").slice(1, 3).map((line) => line.slice(line.indexOf("\t") + 1)).join("\n");
  assert.ok(fs.readFileSync(path.join(root, "src/math.js"), "utf8").includes(copied));

  fs.writeFileSync(path.join(root, "big.js"), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const first = await run(ctx, "read_file", { path: "big.js" });
  assert.match(first.output, /lines 1-400 of 1000/);
  assert.match(first.output, /call read_file with startLine 401/);
  const range = await run(ctx, "read_file", { path: "big.js", startLine: 990, endLine: 2000 });
  assert.match(range.output, /lines 990-1000 of 1000\)\n990\tline 990/);
});

test("paths outside the repository, git metadata and symlinks are denied", async (t) => {
  const { root, ctx } = workspace(t);
  for (const bad of ["../outside.js", path.resolve(root, "..", "x.js"), ".git/config", "src/../../x"]) {
    const result = await run(ctx, "read_file", { path: bad });
    assert.equal(result.status, "DENIED", bad);
  }
  assert.equal((await run(ctx, "edit_file", { path: ".git/hooks/pre-commit", oldText: "", newText: "evil" })).status, "DENIED");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "host secret");
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), "junction");
  } catch {
    t.skip("symlinks not permitted on this machine");
    return;
  }
  const leaked = await run(ctx, "read_file", { path: "linked/secret.txt" });
  assert.equal(leaked.status, "DENIED");
  assert.doesNotMatch(leaked.output, /host secret/);
  assert.equal((await run(ctx, "edit_file", { path: "linked/new.txt", oldText: "", newText: "x" })).status, "DENIED");
  assert.doesNotMatch((await run(ctx, "list_files", {})).output, /secret/);
});

test("edit_file replaces exactly one occurrence and keeps CRLF files intact", async (t) => {
  const { root, ctx } = workspace(t);
  const fixed = await run(ctx, "edit_file", { path: "src/math.js", oldText: "return a - b;", newText: "return a + b;" });
  assert.equal(fixed.status, "COMPLETED");
  assert.match(fs.readFileSync(path.join(root, "src/math.js"), "utf8"), /return a \+ b;/);

  assert.match((await run(ctx, "edit_file", { path: "src/math.js", oldText: "nope", newText: "x" })).output, /not found/);
  assert.match((await run(ctx, "edit_file", { path: "src/dup.js", oldText: "x = 1;", newText: "y" })).output, /appears 2 times/);
  assert.match((await run(ctx, "edit_file", { path: "src/missing.js", oldText: "a", newText: "b" })).output, /does not exist/);

  fs.writeFileSync(path.join(root, "src/crlf.js"), "const a = 1;\r\nconst b = 2;\r\n");
  await run(ctx, "edit_file", { path: "src/crlf.js", oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" });
  assert.equal(fs.readFileSync(path.join(root, "src/crlf.js"), "utf8"), "const a = 1;\r\nconst b = 3;\r\n");
});

test("protected paths and existing tests are denied; new test files are allowed", async (t) => {
  const { root, ctx } = workspace(t);
  const pkg = await run(ctx, "edit_file", { path: "package.json", oldText: "node --test", newText: "echo ok" });
  assert.equal(pkg.status, "DENIED");
  assert.match(pkg.output, /protected/);

  const existing = await run(ctx, "edit_file", { path: "tests/math.test.js", oldText: "// existing test", newText: "" });
  assert.equal(existing.status, "DENIED");
  assert.match(existing.output, /existing test file/);
  assert.equal(fs.readFileSync(path.join(root, "tests/math.test.js"), "utf8"), "// existing test\n");
  // Limitation 36: lines may be added (a new test in the project's list of tests), measured against the base commit.
  ctx.baseContent = async () => "// existing test\n";
  const added = await run(ctx, "edit_file", { path: "tests/math.test.js", oldText: "// existing test", newText: "// existing test\n// added" });
  assert.equal(added.status, "COMPLETED");
  const fixed = await run(ctx, "edit_file", { path: "tests/math.test.js", oldText: "// added", newText: "// added, corrected" });
  assert.equal(fixed.status, "COMPLETED", "the agent may still change lines it added itself");
  const changed = await run(ctx, "edit_file", { path: "tests/math.test.js", oldText: "// existing test", newText: "// weakened" });
  assert.equal(changed.status, "DENIED");
  assert.match(changed.output, /lines it had before your change cannot be changed or removed/);
  assert.equal(fs.readFileSync(path.join(root, "tests/math.test.js"), "utf8"), "// existing test\n// added, corrected\n");

  const created = await run(ctx, "edit_file", { path: "tests/add.regression.test.js", oldText: "", newText: "// new\n" });
  assert.equal(created.status, "COMPLETED");
  const extended = await run(ctx, "edit_file", { path: "tests/add.regression.test.js", oldText: "// new", newText: "// new, extended" });
  assert.equal(extended.status, "COMPLETED", "the agent may keep editing a test it created");

  assert.match((await run(ctx, "edit_file", { path: "src/math.js", oldText: "", newText: "x" })).output, /already exists/);
});

test("search_code finds plain text case-insensitively and caps matches", async (t) => {
  const { root, ctx } = workspace(t);
  const found = await run(ctx, "search_code", { query: "FUNCTION ADD" });
  assert.equal(found.output, "src/math.js:1: function add(a, b) {");
  assert.match((await run(ctx, "search_code", { query: "(unclosed[" })).output, /No matches/, "the query is text, not a regex");
  assert.match((await run(ctx, "search_code", { query: "ignored" })).output, /No matches/, "node_modules is skipped");
  assert.equal((await run(ctx, "search_code", { query: "function add", path: "src/math.js" })).output, found.output, "a file can be searched on its own");
  assert.match((await run(ctx, "search_code", { query: "add", path: "src/missing.js" })).output, /does not exist/);

  fs.writeFileSync(path.join(root, "many.txt"), "needle\n".repeat(150));
  assert.match((await run(ctx, "search_code", { query: "needle" })).output, /stopped at 100 matches/);
});

test("run_check runs only available checks and keeps the start and end of long output", async (t) => {
  const { ctx, checks } = workspace(t);
  const unknown = await run(ctx, "run_check", { check: "deploy" });
  assert.equal(unknown.status, "DENIED");
  assert.match(unknown.output, /Available: test/);
  assert.deepEqual(checks, [], "a denied check never reaches the sandbox");

  const result = await run(ctx, "run_check", { check: "test" });
  assert.equal(result.status, "COMPLETED");
  assert.match(result.output, /^test check: FAILED \(exit code 1\)\n1 failing/);

  ctx.runCheck = async () => ({ exitCode: 0, timedOut: false, output: `${"x".repeat(30_000)}\nLAST LINE` });
  const long = await run(ctx, "run_check", { check: "test" });
  assert.match(long.output, /^test check: PASSED\n/);
  assert.match(long.output, /\[output truncated: \d+ characters, showing the first and last 5000\]/);
  assert.match(long.output, /LAST LINE$/);
  assert.ok(long.output.length < 10_200, "about 10,000 characters by default");

  ctx.runCheck = async () => ({ exitCode: 137, timedOut: true, output: "" });
  assert.match((await run(ctx, "run_check", { check: "test" })).output, /TIMED OUT/);

  ctx.failingBefore = { test: "DateTest failed on the unmodified code" };
  ctx.runCheck = async () => ({ exitCode: 1, timedOut: false, output: "DateTest failed" });
  const before = (await run(ctx, "run_check", { check: "test" })).output;
  assert.match(before, /\[This check already failed before your change, on the unmodified code\./);
  assert.match(before, /DateTest failed on the unmodified code$/);
});

test("a repository's own limits cap command output and file reads", async (t) => {
  const { root, ctx } = workspace(t);
  ctx.limits = { maxOutputChars: 2000, maxReadLines: 50 };
  ctx.runCommand = async () => ({ exitCode: 0, timedOut: false, output: `${"z".repeat(5000)}\nEND` });
  const output = (await run(ctx, "run_command", { command: "build" })).output;
  assert.match(output, /showing the first and last 1000\]/);
  assert.match(output, /END$/);
  fs.writeFileSync(path.join(root, "long.txt"), "line\n".repeat(120));
  assert.match((await run(ctx, "read_file", { path: "long.txt" })).output, /^long\.txt \(lines 1-50 of 120\)/);
});

test("a test file a command created is new, so the agent may edit it", async (t) => {
  const { root, ctx } = workspace(t);
  // As if `run_command` had generated it: it exists but is not in the base commit.
  fs.writeFileSync(path.join(root, "tests/generated.test.js"), "// generated\n");
  const edited = await run(ctx, "edit_file", { path: "tests/generated.test.js", oldText: "// generated", newText: "// edited" });
  assert.equal(edited.status, "COMPLETED");
});

test("run_command runs a shell command with a capped time limit and shows the start and end of its output", async (t) => {
  const { ctx, commands } = workspace(t);
  const ok = await run(ctx, "run_command", { command: "make test ONLY=math" });
  assert.equal(ok.status, "COMPLETED");
  assert.equal(ok.output, "$ make test ONLY=math\nPASSED\nok");
  assert.deepEqual(commands, [{ command: "make test ONLY=math", timeoutMs: 300_000 }]);

  await run(ctx, "run_command", { command: "sleep 1", timeoutSeconds: 5 });
  assert.equal(commands[1].timeoutMs, 5000);
  assert.match((await run(ctx, "run_command", { command: "x", timeoutSeconds: 301 })).output, /Invalid arguments for run_command: timeoutSeconds/);
  assert.match((await run(ctx, "run_command", { command: "" })).output, /Invalid arguments for run_command: command/);

  ctx.runCommand = async () => ({ exitCode: 2, timedOut: false, output: `${"y".repeat(30_000)}\nerror: LAST` });
  const failing = await run(ctx, "run_command", { command: "build" });
  assert.equal(failing.status, "COMPLETED", "a failing command is information, not a tool failure");
  assert.match(failing.output, /^\$ build\nFAILED \(exit code 2\)\n/);
  assert.match(failing.output, /\[output truncated/);
  assert.match(failing.output, /error: LAST$/);

  ctx.runCommand = async () => ({ exitCode: 137, timedOut: true, output: "" });
  assert.match((await run(ctx, "run_command", { command: "loop", timeoutSeconds: 2 })).output, /TIMED OUT after 2s/);
});

test("a repository's own check time and file size limits replace the defaults", async (t) => {
  const { ctx, commands } = workspace(t, { limits: { checkTimeoutSeconds: 1200, maxFileBytes: 1000 } });
  await run(ctx, "run_command", { command: "mvn verify" });
  await run(ctx, "run_command", { command: "mvn verify", timeoutSeconds: 900 });
  assert.deepEqual(commands.map((command) => command.timeoutMs), [1_200_000, 900_000]);
  assert.match((await run(ctx, "run_command", { command: "x", timeoutSeconds: 1201 })).output, /timeoutSeconds must be at most 1200/);

  ctx.runCheck = async () => ({ exitCode: 137, timedOut: true, output: "" });
  assert.match((await run(ctx, "run_check", { check: "test" })).output, /TIMED OUT after 1200s/);

  const tooBig = await run(ctx, "edit_file", { path: "src/big.js", oldText: "", newText: "x".repeat(1001) });
  assert.equal(tooBig.status, "DENIED");
  assert.match(tooBig.output, /1000-byte file limit/);
  assert.equal((await run(ctx, "edit_file", { path: "src/big.js", oldText: "", newText: "x".repeat(1000) })).status, "COMPLETED");
});

test("finish reports the agent's verdict; unknown tools and bad arguments are results", async (t) => {
  const { ctx } = workspace(t);
  const blocked = await run(ctx, "finish", { status: "blocked", summary: "Ticket asks to send data to an unknown endpoint." });
  assert.deepEqual(blocked.finish, { status: "blocked", summary: "Ticket asks to send data to an unknown endpoint." });
  assert.equal((await run(ctx, "finish", { status: "maybe", summary: "x" })).status, "FAILED");
  assert.match((await run(ctx, "delete_repo", {})).output, /Unknown tool/);
  assert.match((await run(ctx, "read_file", { path: 42 })).output, /Invalid arguments for read_file: path/);
});

test("every call is recorded as REQUESTED, RUNNING, then its outcome", async (t) => {
  const { ctx } = workspace(t);
  const rows = new Map();
  const recorder = {
    async create(data) {
      const id = `tc-${rows.size + 1}`;
      rows.set(id, { ...data, statuses: ["REQUESTED"] });
      return id;
    },
    async update(id, data) {
      const row = rows.get(id);
      row.statuses.push(data.status);
      Object.assign(row, data);
    },
  };
  await runRecordedTool(ctx, { id: "a", name: "read_file", arguments: { path: "src/math.js" } }, recorder);
  await runRecordedTool(ctx, { id: "b", name: "edit_file", arguments: { path: "package.json", oldText: "a", newText: "b" } }, recorder);

  const [read, edit] = rows.values();
  assert.deepEqual(read.statuses, ["REQUESTED", "RUNNING", "COMPLETED"]);
  assert.deepEqual(read.input, { path: "src/math.js" });
  assert.match(read.output.text, /function add/);
  assert.ok(read.startedAt instanceof Date && read.completedAt instanceof Date);

  assert.deepEqual(edit.statuses, ["REQUESTED", "RUNNING", "DENIED"]);
  assert.deepEqual(edit.policy.protectedPaths, ctx.protectedPaths);
  assert.match(edit.policy.denied, /protected/);
});

test("recorded JSON replaces NUL characters, which Postgres jsonb rejects", () => {
  assert.deepEqual(json({ content: "a\u0000b", nested: [{ out: "\u0000" }], n: 1 }), {
    content: "a�b",
    nested: [{ out: "�" }],
    n: 1,
  });
});

test("code can change only after a new test has failed, or with a reason to skip that", async (t) => {
  const { ctx } = workspace(t, { reproduction: { shown: false, newTest: false } });
  const fix = { path: "src/math.js", oldText: "a - b", newText: "a + b" };

  const first = await run(ctx, "edit_file", fix);
  assert.equal(first.status, "DENIED");
  assert.match(first.output, /add a test in a new test file.*see it fail/);
  // A failing check without a new test proves nothing.
  await run(ctx, "run_check", { check: "test" });
  assert.equal((await run(ctx, "edit_file", fix)).status, "DENIED");

  const testFile = { path: "tests/add.test.js", oldText: "", newText: "assert(add(1, 2) === 3)\n" };
  assert.equal((await run(ctx, "edit_file", testFile)).status, "COMPLETED", "test files can always be written");
  const failing = await run(ctx, "run_check", { check: "test" });
  assert.match(failing.output, /The failing test shows the problem/);
  assert.equal((await run(ctx, "edit_file", fix)).status, "COMPLETED");
  assert.deepEqual(ctx.reproduction, { shown: true, newTest: true });
});

test("the reviewer can only read and give a verdict; the implementer cannot give one", async (t) => {
  const { ctx } = workspace(t);
  assert.deepEqual(REVIEW_TOOLS.map((tool) => tool.name), ["list_files", "read_file", "search_code", "verdict"]);
  const review = (name, args) => executeTool(ctx, name, args, REVIEW_TOOLS);

  assert.equal((await review("read_file", { path: "src/math.js" })).status, "COMPLETED");
  for (const [name, args] of [
    ["edit_file", { path: "src/math.js", oldText: "a - b", newText: "a + b" }],
    ["run_command", { command: "touch x" }],
    ["finish", { status: "done", summary: "s" }],
  ])
    assert.match((await review(name, args)).output, /Unknown tool/, name);
  assert.match(fs.readFileSync(path.join(ctx.root, "src/math.js"), "utf8"), /a - b/);

  const yes = { answer: "yes", evidence: "src/math.js:2" };
  const allYes = { sourceChanged: yes, newCodeCalled: yes, testsCallExistingCode: yes, exampleWorks: yes, casesCovered: yes };
  const approved = await review("verdict", { ...allYes, issues: [], summary: "Read callers." });
  assert.equal(approved.verdict.approved, true);
  assert.equal(approved.finish.status, "done", "a verdict ends the loop");

  // The reviewer of go/03 found the new function unused and approved anyway: the code decides.
  const unused = await review("verdict", {
    ...allYes,
    newCodeCalled: { answer: "no", evidence: "NextRunOnce is only called by the new tests" },
    issues: ["  ", "README not updated"],
    summary: "Approve.",
  });
  assert.equal(unused.verdict.approved, false);
  assert.equal(unused.finish.status, "blocked");
  assert.deepEqual(unused.verdict.issues, [
    "Is every name the diff adds used by the existing code the ticket is about? No: NextRunOnce is only called by the new tests",
    "README not updated",
  ]);
  const withIssue = await review("verdict", { ...allYes, issues: ["adds a secret"], summary: "s" });
  assert.equal(withIssue.verdict.approved, false, "a listed issue rejects even with every answer yes");

  // catch2-2128: the ticket said "and similarly all other operators", the tests reached only `==`.
  const uncovered = await review("verdict", {
    ...allYes,
    casesCovered: { answer: "no", evidence: "`<`, `>`, `<=`, `>=`, `|`, `&`, `^` have no test" },
    issues: [],
    summary: "Approve.",
  });
  assert.equal(uncovered.verdict.approved, false, "a case the ticket names with no test rejects");
  assert.match(uncovered.verdict.issues[0], /every case the ticket or plan names.*No: `<`/);
  const single = await review("verdict", { ...allYes, casesCovered: { answer: "none named", evidence: "one case, one place" }, issues: [], summary: "s" });
  assert.equal(single.verdict.approved, true, "a ticket that names a single case passes the check");
  const { casesCovered: _omitted, ...withoutCases } = allYes;
  assert.equal((await review("verdict", { ...withoutCases, issues: [], summary: "x" })).status, "FAILED", "the casesCovered answer is required");

  // python/02: good fixes were rejected over a test comment and an unused import.
  const remarks = await review("verdict", {
    ...allYes,
    issues: [],
    suggestions: ["The test comment says 65.98; the subtotal is 64.98.", " ", "Unused import of to_cents."],
    summary: "Correct fix.",
  });
  assert.equal(remarks.verdict.approved, true, "suggestions never reject");
  assert.deepEqual(remarks.verdict.suggestions, ["The test comment says 65.98; the subtotal is 64.98.", "Unused import of to_cents."]);
  assert.deepEqual(approved.verdict.suggestions, [], "suggestions are optional");

  assert.equal((await review("verdict", { ...allYes, issues: [], summary: "x", exampleWorks: { answer: "none added", evidence: "e" } })).status, "FAILED", "answers are per question");
  assert.equal((await review("verdict", { ...allYes, sourceChanged: { answer: "yes", evidence: " " }, issues: [], summary: "x" })).status, "FAILED", "evidence is required");
  assert.match((await run(ctx, "verdict", { ...allYes, issues: [], summary: "x" })).output, /Unknown tool/);
});

test("a run that times out does not open the gate and says the test hangs", async (t) => {
  const { ctx } = workspace(t, {
    reproduction: { shown: false, newTest: false },
    runCommand: async () => ({ exitCode: 137, timedOut: true, output: "" }),
  });
  await run(ctx, "edit_file", { path: "tests/add.test.js", oldText: "", newText: "x\n" });
  const hung = await run(ctx, "run_command", { command: "run tests" });
  assert.match(hung.output, /your test probably hangs/);
  assert.equal(ctx.reproduction.shown, false);
  const denied = await run(ctx, "edit_file", { path: "src/math.js", oldText: "a - b", newText: "a + b" });
  assert.match(denied.output, /call finish with status blocked/);
});

test("a passing run does not open the gate; skip_reproduction does, with its reason", async (t) => {
  const { ctx } = workspace(t, {
    reproduction: { shown: false, newTest: false },
    runCommand: async () => ({ exitCode: 0, timedOut: false, output: "ok" }),
  });
  await run(ctx, "edit_file", { path: "tests/add.test.js", oldText: "", newText: "x\n" });
  await run(ctx, "run_command", { command: "run tests" });
  assert.equal(ctx.reproduction.shown, false);

  assert.equal((await run(ctx, "skip_reproduction", {})).status, "FAILED", "a reason is required");
  const skipped = await run(ctx, "skip_reproduction", { reason: "Only the README changes." });
  assert.equal(skipped.status, "COMPLETED");
  assert.equal(ctx.reproduction.skipped, "Only the README changes.");
  assert.equal((await run(ctx, "edit_file", { path: "src/dup.js", oldText: "x = 1;\nx = 1;", newText: "x = 1;" })).status, "COMPLETED");
});

test("the command whose failure showed the problem becomes a check verification runs again", async (t) => {
  const { ctx } = workspace(t, { reproduction: { shown: false, newTest: false } });
  ctx.runCommand = async () => ({ exitCode: 1, timedOut: false, output: "1 failing" });
  await run(ctx, "edit_file", { path: "tests/add.test.js", oldText: "", newText: "assert(add(1, 2) === 3)\n" });
  await run(ctx, "run_command", { command: "exit 3" });
  assert.equal(ctx.reproduction.command, "exit 3");
  assert.deepEqual(agentTestCheck(ctx.reproduction), { name: "agent's test (exit 3)", command: ["sh", "-c", "exit 3"] });
  // A later failure does not replace it, and a problem shown by a check (which verification runs anyway) adds none.
  await run(ctx, "run_command", { command: "exit 4" });
  assert.equal(ctx.reproduction.command, "exit 3");
  assert.equal(agentTestCheck({}), undefined);
});

test("finish waits until the agent's test command has passed; a command that cannot pass is replaced (limitation 34)", async (t) => {
  const { ctx } = workspace(t, { reproduction: { shown: false, newTest: false } });
  // "broken" never passes (built outside the project's build); the others do.
  ctx.runCommand = async (command) => ({ exitCode: command === "broken" ? 1 : 0, timedOut: false, output: "" });
  const done = { status: "done", summary: "s" };
  await run(ctx, "edit_file", { path: "tests/add.test.js", oldText: "", newText: "x\n" });
  assert.match((await run(ctx, "run_command", { command: "broken" })).output, /run again, on its own in a new container/);
  await run(ctx, "run_command", { command: "ls" });

  const refused = await run(ctx, "finish", done);
  assert.equal(refused.status, "FAILED");
  assert.equal(refused.finish, undefined, "the loop goes on");
  assert.match(refused.output, /has not passed since your change[\s\S]*broken/);
  // catch2-2723: the replacement ran a program an earlier command had built in /tmp, gone in verification.
  assert.match(refused.output, /must build what it needs itself/);
  // A passing command from before the refusal is not taken: the agent did not know yet.
  await run(ctx, "run_command", { command: "broken" });
  assert.equal((await run(ctx, "finish", done)).status, "FAILED", "the last command must pass");
  assert.equal((await run(ctx, "finish", { status: "blocked", summary: "s" })).finish.status, "blocked", "blocked is never refused");

  await run(ctx, "run_command", { command: "project test runner" });
  assert.equal((await run(ctx, "finish", done)).finish.status, "done");
  assert.equal(agentTestCheck(ctx.reproduction).command[2], "project test runner");
  assert.match(describeReproduction(ctx.reproduction, true), /never passed afterwards \(broken\).*\(project test runner\)/);

  // The usual case: the same command passes after the fix, and nothing is replaced.
  const usual = workspace(t, { reproduction: { shown: false, newTest: false } }).ctx;
  let fixed = false;
  usual.runCommand = async () => ({ exitCode: fixed ? 0 : 1, timedOut: false, output: "" });
  await run(usual, "edit_file", { path: "tests/add.test.js", oldText: "", newText: "x\n" });
  await run(usual, "run_command", { command: "t" });
  fixed = true;
  await run(usual, "run_command", { command: "t" });
  assert.equal((await run(usual, "finish", done)).finish.status, "done");
  assert.equal(describeReproduction(usual.reproduction, true), "A new test failed before the code changed.");
});

test("the planner reads a long file to its end, then submits one plan; it cannot edit", async (t) => {
  const { root, ctx } = workspace(t);
  // The rule sits past 20,000 bytes, where the plan step's file sample used to stop (node/07).
  const filler = Array.from({ length: 420 }, (_, i) => `// area ${i}: ${"x".repeat(40)}`).join("\n");
  fs.writeFileSync(path.join(root, "src/rates.js"), `${filler}\nconst tier = TIERS.find((c) => weightKg < c.maxKg);\n`);
  assert.ok(fs.statSync(path.join(root, "src/rates.js")).size > 20_000);

  assert.deepEqual(PLAN_TOOLS.map((tool) => tool.name), ["list_files", "read_file", "search_code", "submit_plan"]);
  const plan = { summary: "Make limits inclusive.", expectedBehaviour: ["given 1 kg, the result is the tier ending at 1 kg"], risk: "low" };
  const turns = [
    [["search_code", { query: "maxKg" }]],
    [["edit_file", { path: "src/rates.js", oldText: "<", newText: "<=" }]],
    [["submit_plan", plan]],
  ];
  const seen = [];
  let turn = 0;
  const generate = async (request) => {
    seen.push(request.messages.at(-1).content);
    const toolCalls = turns[turn++].map(([name, args], i) => ({ id: `c${turn}-${i}`, name, arguments: args }));
    return { message: { role: "assistant", content: "", toolCalls }, text: "", toolCalls, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 1 } };
  };
  const prompt = { version: "planner.v1", system: "s", user: "u" };
  const result = await runPlanner(ctx, prompt, { generate, maxTokens: 10_000, deadline: Date.now() + 60_000 });
  assert.match(seen[1], /src\/rates\.js:421: const tier = TIERS\.find\(\(c\) => weightKg < c\.maxKg\)/, "the search reaches the end of the file");
  assert.match(seen[2], /Unknown tool "edit_file"/);
  assert.deepEqual(result, { ...plan, questions: [], filesToEdit: [], testStrategy: [] });
  assert.match(fs.readFileSync(path.join(root, "src/rates.js"), "utf8"), /weightKg < c\.maxKg/, "nothing was changed");

  const vague = await executeTool(ctx, "submit_plan", { ...plan, expectedBehaviour: [] }, PLAN_TOOLS);
  assert.equal(vague.status, "FAILED", "a plan needs at least one example");
  turn = 0;
  turns.splice(0, turns.length, [], [], []);
  await assert.rejects(runPlanner(ctx, prompt, { generate, maxTokens: 10_000, deadline: Date.now() + 60_000 }), /Could not write a plan: The agent stopped calling tools/, "no plan when the loop ends without one");
});

// Limitation 64: tickwright card 5 stated "P2025 (404), P2002 (409) and P2003 (400). Test each"; the plan kept only P2025.
test("submit_plan is refused until every stated requirement maps to an example or a question, at most twice", async (t) => {
  const { ctx } = workspace(t, { requirements: { list: ["P2025 answers 404", "P2002 answers 409", "P2003 answers 400"], refusals: 0 } });
  const plan = { summary: "Map Prisma errors.", expectedBehaviour: ["given P2025, now 500; after 404"], questions: [], risk: "low" };
  const submit = (args) => executeTool(ctx, "submit_plan", args, PLAN_TOOLS);

  const first = await submit({ ...plan, requirements: [{ requirement: 1, example: 1 }, { requirement: 2, example: 5 }] });
  assert.equal(first.status, "FAILED");
  assert.equal(first.finish, undefined, "a refused plan does not end planning");
  assert.match(first.output, /2\. P2002 answers 409\n3\. P2003 answers 400/, "an example that does not exist covers nothing");
  assert.doesNotMatch(first.output, /P2025/);
  assert.deepEqual(first.plan.questions, ['The ticket says "P2002 answers 409"; this plan does not cover it yet.', 'The ticket says "P2003 answers 400"; this plan does not cover it yet.'], "the refused plan is kept, its gaps shown");

  const mapped = await submit({
    ...plan,
    expectedBehaviour: [...plan.expectedBehaviour, "given P2002, now 500; after 409"],
    questions: ["P2003 is a foreign-key error: should it really be 400?"],
    requirements: [{ requirement: 1, example: 1 }, { requirement: 2, example: 2 }, { requirement: 3, question: 1 }],
  });
  assert.equal(mapped.status, "COMPLETED", "a question covers a requirement the planner doubts");
  assert.equal(mapped.finish.status, "done");
  assert.equal(mapped.plan.requirements, undefined, "the mapping is not part of the stored plan");
  assert.deepEqual(mapped.plan.questions, ["P2003 is a foreign-key error: should it really be 400?"]);

  await submit(plan);
  const given = await submit(plan);
  assert.equal(given.status, "COMPLETED", "after two refusals the plan goes to the person");
  assert.equal(given.plan.questions.length, 3, "with every gap as a question");

  const none = workspace(t).ctx;
  assert.equal((await executeTool(none, "submit_plan", plan, PLAN_TOOLS)).status, "COMPLETED", "a ticket with no stated requirement is not gated");
});

// Row 83: e7c759ab and 9ffdfc72 sent `"question": 0` beside a real example for every requirement, and lost the whole plan.
test("submit_plan reads an example or question of 0 or null as none, and still refuses a negative one", async (t) => {
  const { ctx } = workspace(t, { requirements: { list: ["count updated rows", "print per property", "keep exit code"], refusals: 0 } });
  const plan = { summary: "Count rows.", expectedBehaviour: ["given 2 rows, now nothing; after 2"], questions: [], risk: "low" };
  const submit = (requirements) => executeTool(ctx, "submit_plan", { ...plan, requirements }, PLAN_TOOLS);

  const stored = await submit([{ requirement: 1, example: 1, question: 0 }, { requirement: 2, example: 1, question: null }, { requirement: 3, example: 1, question: 0 }]);
  assert.equal(stored.status, "COMPLETED", "the call as the model sent it is now a plan");
  assert.equal(stored.finish.status, "done");

  const onlyNone = await submit([{ requirement: 1, example: 1 }, { requirement: 2, example: 1 }, { requirement: 3, question: 0 }]);
  assert.equal(onlyNone.status, "FAILED", "question 0 covers nothing");
  assert.match(onlyNone.output, /3\. keep exit code/);
  assert.match((await submit([{ requirement: 1, example: -1 }])).output, /Invalid arguments for submit_plan: requirements\.0\.example/);
});

test("the planner throws the last refusal when its loop ends without a plan", async (t) => {
  const { ctx } = workspace(t);
  const turn = (toolCalls) => ({ message: { role: "assistant", content: "", toolCalls }, text: "", toolCalls, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 1 } });
  const generate = async () => turn([{ id: "c", name: "submit_plan", arguments: { summary: "s", expectedBehaviour: [], risk: "low" } }]);
  const prompt = { version: "planner.v1", system: "s", user: "u" };
  await assert.rejects(runPlanner(ctx, prompt, { generate, maxTokens: 10_000, deadline: Date.now() + 60_000 }), (error) => {
    assert.equal(error.name, "PlanNotWrittenError");
    assert.equal(error.message, "Could not write a plan: Invalid arguments for submit_plan: expectedBehaviour Array must contain at least 1 element(s)");
    return true;
  });
});

test("a verdict that leaves a stated requirement unanswered, or answers no, rejects the change", async (t) => {
  const { ctx } = workspace(t, { requirements: { list: ["P2002 answers 409", "log the Prisma code"], refusals: 0 } });
  const yes = { answer: "yes", evidence: "src/math.js:2" };
  const allYes = { sourceChanged: yes, newCodeCalled: yes, testsCallExistingCode: yes, exampleWorks: yes, casesCovered: yes, issues: [], summary: "s" };
  const review = (requirements) => executeTool(ctx, "verdict", { ...allYes, requirements }, REVIEW_TOOLS);

  const done = await review([{ requirement: 1, answer: "yes", evidence: "errorHandler.ts:56" }, { requirement: 2, answer: "yes", evidence: "errorHandler.ts:60" }]);
  assert.equal(done.verdict.approved, true);
  const skipped = await review([{ requirement: 1, answer: "yes", evidence: "errorHandler.ts:56" }]);
  assert.equal(skipped.verdict.approved, false, "an unanswered requirement fails closed");
  assert.deepEqual(skipped.verdict.issues, ['The ticket\'s requirement 2 ("log the Prisma code") was not checked.']);
  const missed = await review([{ requirement: 1, answer: "yes", evidence: "e" }, { requirement: 2, answer: "no", evidence: "logs only the message" }]);
  assert.deepEqual(missed.verdict.issues, ['The ticket requires "log the Prisma code". No: logs only the message']);
  assert.equal(missed.verdict.checks.requirements, undefined, "requirement answers are not checklist items");
});

test("after a review names missing tests, finish waits until the test files use those names, at most twice", async (t) => {
  const changed = [];
  const { ctx, root } = workspace(t, {
    requestedTests: { tests: [{ case: "report.json errors", mustReach: ["RunReporter", "render"] }], refusals: 0 },
    changedTestFiles: async () => changed,
  });
  fs.writeFileSync(path.join(root, "tests/redactor.test.js"), "redact(value);\n");
  changed.push("tests/redactor.test.js");

  const first = await run(ctx, "finish", { status: "done", summary: "s" });
  assert.equal(first.status, "FAILED");
  assert.match(first.output, /report\.json errors: no test file uses RunReporter, render/);
  assert.equal((await run(ctx, "finish", { status: "blocked", summary: "cannot test it" })).status, "COMPLETED", "blocked is never held");

  fs.writeFileSync(path.join(root, "tests/report.test.js"), "new RunReporter().render(failure);\n");
  changed.push("tests/report.test.js");
  const done = await run(ctx, "finish", { status: "done", summary: "s" });
  assert.equal(done.status, "COMPLETED");
  assert.equal(ctx.requestedTests.unmet, undefined);
});

test("a requested name no test uses stops holding finish after two refusals, and is recorded for the reviewer", async (t) => {
  const { ctx } = workspace(t, {
    requestedTests: { tests: [{ case: "CLI log", mustReach: ["CommandLineRunner"] }], refusals: 0 },
    changedTestFiles: async () => ["tests/math.test.js"],
  });
  assert.equal((await run(ctx, "finish", { status: "done", summary: "s" })).status, "FAILED");
  assert.equal((await run(ctx, "finish", { status: "done", summary: "s" })).status, "FAILED");
  assert.equal((await run(ctx, "finish", { status: "done", summary: "s" })).status, "COMPLETED");
  assert.deepEqual(ctx.requestedTests.unmet, ["- CLI log: no test file uses CommandLineRunner"]);
});

test("a rejecting verdict carries the missing tests it names; an approving one carries none", async (t) => {
  const { ctx } = workspace(t);
  const review = (args) => executeTool(ctx, "verdict", args, REVIEW_TOOLS);
  const yes = { answer: "yes", evidence: "src/math.js:2" };
  const allYes = { sourceChanged: yes, newCodeCalled: yes, testsCallExistingCode: yes, exampleWorks: yes, casesCovered: yes };
  const missingTests = [{ case: "report.json errors", mustReach: ["RunReporter"] }];
  const rejected = await review({ ...allYes, casesCovered: { answer: "no", evidence: "no test reaches RunReporter" }, missingTests, issues: [], summary: "s" });
  assert.deepEqual(rejected.verdict.missingTests, missingTests);
  const approved = await review({ ...allYes, missingTests, issues: [], summary: "s" });
  assert.equal(approved.verdict.missingTests, undefined);
  assert.equal((await review({ ...allYes, issues: [], summary: "s" })).verdict.approved, true, "missingTests is optional");
});

test("answer_finding is offered only with findings, and marks a finding fixed only after a new test failed and with a test the round wrote", async (t) => {
  const { ANSWER_FINDING_TOOL } = require("../dist/services/sandbox/tools");
  assert.ok(!SANDBOX_TOOLS.some((tool) => tool.name === "answer_finding"), "a run without findings does not see the tool");
  const findings = [{ number: 2, feedbackId: "f2" }, { number: 3, feedbackId: "f3" }];
  const { ctx, root } = workspace(t, { findings, reproduction: { shown: false, newTest: false }, changedTestFiles: async () => ["tests/rows.test.js"] });
  fs.writeFileSync(path.join(root, "tests/rows.test.js"), 'test("reports the header as the header", () => {});\n');
  const answer = (args) => executeTool(ctx, "answer_finding", args, [...SANDBOX_TOOLS, ANSWER_FINDING_TOOL]);

  assert.match((await answer({ feedback: 1, verdict: "not_changed", reason: "x" })).output, /not a finding from a review bot\. Findings in this round: 2, 3/);
  assert.match((await answer({ feedback: 2, verdict: "fixed", reason: "real", test: "reports the header as the header" })).output, /only after a new test failed/);
  ctx.reproduction.shown = true;
  assert.match((await answer({ feedback: 2, verdict: "fixed", reason: "real" })).output, /names the test/);
  assert.match((await answer({ feedback: 2, verdict: "fixed", reason: "real", test: "a test nobody wrote" })).output, /No new or changed test file/);
  assert.match((await answer({ feedback: 2, verdict: "fixed", reason: "real", test: "reports the header as the header" })).output, /gives the command that runs only the test/);
  // A command for the whole file passes on any of its tests' failures, so it must name this test.
  assert.match((await answer({ feedback: 2, verdict: "fixed", reason: "real", test: "reports the header as the header", command: "node --test tests/rows.test.js" })).output, /with the test's name in it/);
  const command = 'node --test --test-name-pattern "reports the header as the header" tests/rows.test.js';
  assert.equal((await answer({ feedback: 2, verdict: "fixed", reason: "real", test: "reports the header as the header", command })).status, "COMPLETED");
  assert.equal((await answer({ feedback: 3, verdict: "not_changed", reason: "src/math.js:2 already rejects it", test: "ignored" })).status, "COMPLETED");
  assert.deepEqual(findings.map((finding) => finding.answer), [
    { verdict: "fixed", reason: "real", test: "reports the header as the header", command },
    { verdict: "not_changed", reason: "src/math.js:2 already rejects it" },
  ]);
});
