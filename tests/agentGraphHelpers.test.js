const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const { reviewDiffSafety } = require("../dist/services/agentGraph/diffReview");
const {
  collectRepoContext,
  instructionsOf,
  readInstructionFiles,
} = require("../dist/services/agentGraph/repoContext");
const {
  checkExistingTests,
  onlyAddsLines,
  checkRepositoryPolicy,
} = require("../dist/services/agentGraph/repoPolicy");
const {
  MODE_PROBE_SCRIPT,
  WORKSPACE_RESET_COMMANDS,
} = require("../dist/services/workspaceService");

test("diff review rejects added secrets", () => {
  const result = reviewDiffSafety(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "+const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';",
    ].join("\n"),
    ["src/app.ts"],
  );

  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /secret|credential/i);
});

test("repo context selects likely relevant files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-graph-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await fs.writeFile(path.join(root, "README.md"), "# Demo\n");
  await fs.writeFile(
    path.join(root, "src", "trelloAdapter.ts"),
    "export const syncTrello = () => undefined;\n",
  );

  const context = await collectRepoContext(root, "Fix Trello sync bug", { language: "JavaScript/TypeScript (Node)", checks: { test: ["npm", "run", "test"] } });

  assert.ok(context.fileTree.includes("src/trelloAdapter.ts"));
  assert.deepEqual(context.checks, ["test"]);
  assert.match(context.summary, /Language: JavaScript/);
  assert.ok(context.selectedFiles.includes("src/trelloAdapter.ts"));
  assert.match(context.summary, /src\/trelloAdapter\.ts/);
});

test("the project's instruction files are the configured ones, in order, inside the repository and within the size limit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  t.after(() => Promise.all([root, outside].map((dir) => fs.rm(dir, { recursive: true, force: true }))));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "STYLE.md"), "Name tests after the rule.\n");
  await fs.writeFile(path.join(root, "GUIDE.md"), "x".repeat(50));
  await fs.writeFile(path.join(outside, "secret.md"), "outside-text");
  let linked = true;
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "link.md")).catch(() => (linked = false));

  assert.equal(await readInstructionFiles(root, []), "None are configured for this repository.");
  const text = await readInstructionFiles(root, ["docs/STYLE.md", "missing.md", "../outside/secret.md", "GUIDE.md", ...(linked ? ["link.md"] : [])], 40);
  assert.match(text, /^--- docs\/STYLE\.md\nName tests after the rule\.\n/);
  assert.match(text, /--- missing\.md\n\(not found\)/);
  assert.match(text, /--- \.\.\/outside\/secret\.md\n\(not read: outside the repository/);
  assert.match(text, /--- GUIDE\.md\nx{13}\n\[cut at the size limit\]/, "the rest of the limit, then cut");
  if (linked) assert.match(text, /--- link\.md\n\(not read: outside the repository or through a symbolic link\)/);
  assert.doesNotMatch(text, /outside-text/);
  assert.ok(text.indexOf("docs/STYLE.md") < text.indexOf("GUIDE.md"), "in the configured order");

  const files = instructionsOf({ verificationConfig: { instructionFiles: ["docs/STYLE.md"] }, executionPolicy: { maxInstructionChars: 5000 } });
  assert.deepEqual(files, { files: ["docs/STYLE.md"], maxChars: 5000 });
  const context = await collectRepoContext(root, "t", { checks: {} }, files);
  assert.match(context.instructions, /Name tests after the rule/);
});

test("M5: repo context skips dotfiles and excluded dirs but keeps .env.example", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-graph-"));
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, ".github"), { recursive: true });
  await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-send\n");
  await fs.writeFile(path.join(root, ".env.example"), "SECRET=\n");
  await fs.writeFile(path.join(root, ".github", "ci.yml"), "on: push\n");
  await fs.writeFile(path.join(root, "dist", "index.js"), "built\n");
  await fs.writeFile(path.join(root, "index.js"), "source\n");

  const context = await collectRepoContext(root, "Fix env handling", { language: "unknown", checks: {} });

  assert.deepEqual(context.fileTree, [".env.example", "index.js"]);
  assert.doesNotMatch(context.summary, /do-not-send/);
});

test("M3: repository policy returns retry feedback instead of throwing", () => {
  assert.equal(checkRepositoryPolicy(["src/a.js"], {}), undefined);
  assert.equal(checkRepositoryPolicy(["src/a.js"], null), undefined);

  const protectedHit = checkRepositoryPolicy(
    ["src/a.js", "package.json", ".github/workflows/ci.yml"],
    {},
  );
  assert.match(protectedHit, /package\.json, \.github\/workflows\/ci\.yml/);
  assert.doesNotMatch(protectedHit, /src\/a\.js/);

  // Only a path or a folder prefix counts, not a name that merely starts with it.
  assert.equal(
    checkRepositoryPolicy(["package.json.bak", ".githubrc"], {}),
    undefined,
  );

  const tooMany = checkRepositoryPolicy(["a", "b", "c"], { maxChangedFiles: 2 });
  assert.match(tooMany, /touches 3 files; the limit is 2/);

  const custom = checkRepositoryPolicy(["tests/a.test.js"], {
    protectedPaths: ["tests"],
  });
  assert.match(custom, /tests\/a\.test\.js/);
});

test("M2: workspace reset drops edits and new files but keeps node_modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-reset-"));
  const git = (...args) =>
    execFileAsync("git", args, { cwd: root }).then((result) => result.stdout);
  await git("init", "--quiet");
  await git("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await fs.writeFile(path.join(root, "index.js"), "original\n");
  await git("add", ".");
  await git(
    "-c", "user.name=test", "-c", "user.email=test@localhost",
    "commit", "--quiet", "-m", "base",
  );

  // A failed attempt: an edit, a new file, an intent-to-add entry (as
  // changedFiles leaves behind) and a new folder.
  await fs.writeFile(path.join(root, "index.js"), "broken\n");
  await fs.writeFile(path.join(root, "added.js"), "new\n");
  await fs.mkdir(path.join(root, "lib"));
  await fs.writeFile(path.join(root, "lib", "helper.js"), "new\n");
  await git("add", "-N", ".");
  await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "dep\n");

  // Same commands the container runs, without the leading "git".
  for (const command of WORKSPACE_RESET_COMMANDS) await git(...command.slice(1));

  assert.equal(await fs.readFile(path.join(root, "index.js"), "utf8"), "original\n");
  await assert.rejects(fs.access(path.join(root, "added.js")));
  await assert.rejects(fs.access(path.join(root, "lib")));
  await fs.access(path.join(root, "node_modules", "dep", "index.js"));
  assert.equal(await git("status", "--porcelain"), "");
});

test(
  "a clone keeps file modes, so a new script made executable reaches the diff, unless files the host writes look executable",
  { skip: process.platform === "win32" && "file modes need a Linux file system" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mode-"));
    const git = (...args) => execFileAsync("git", args, { cwd: root }).then((result) => result.stdout);
    const probe = async (probeMode) => {
      await fs.writeFile(path.join(root, ".git", "mode-probe"), "", { mode: probeMode });
      await execFileAsync("sh", ["-c", MODE_PROBE_SCRIPT], { cwd: root });
      await assert.rejects(fs.access(path.join(root, ".git", "mode-probe")));
      return (await git("config", "core.fileMode")).trim();
    };
    await git("init", "--quiet");
    await git("-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "--quiet", "--allow-empty", "-m", "base");

    // A Windows bind mount shows every file the host writes as executable.
    assert.equal(await probe(0o777), "false");
    assert.equal(await probe(0o644), "true");

    // jq-2624 run 9: the agent's chmod +x on a new test script.
    await fs.writeFile(path.join(root, "run-tests"), "#!/bin/sh\n");
    await fs.chmod(path.join(root, "run-tests"), 0o755);
    await git("add", "-N", ".");
    assert.match(await git("-c", "core.hooksPath=/dev/null", "diff"), /new file mode 100755/);
  },
);

test("implement replies without usable FILE blocks are rejected with a specific reason", () => {
  const { fileActionsError } = require("../dist/services/agentGraph/outputFormat");
  const { parseAgentOutput } = require("../dist/utils/llmUtils");
  const check = (raw) => fileActionsError(raw, parseAgentOutput(raw).actions);

  // The shape Gemini returned in the first benchmark run.
  const arrayReply = '```json\n{\n  "actions": [\n    { "file": "src/pagination.js", "content": "x" }\n  ]\n}\n```';
  assert.match(check(arrayReply), /must be one string of FILE blocks, not an array/);
  assert.match(check('{"actions": {"file": "a.js"}}'), /not object/);
  assert.match(check('{"actions": ""}'), /no FILE blocks/);
  assert.match(check("I could not find the bug."), /no FILE blocks/);
  assert.match(check(JSON.stringify({ actions: "FILE: a.js\nno fence" })), /missing an opening fence/);

  const good = JSON.stringify({ actions: "FILE: src/a.js\n```js\nmodule.exports = 1;\n```" });
  assert.equal(check(good), undefined);
});

test("existing tests may not be modified or deleted by any means; new tests and added lines are allowed", () => {
  const isTest = (file) => file.startsWith("tests/");
  assert.equal(
    checkExistingTests(
      [
        { status: "M", file: "src/a.py" },
        { status: "A", file: "tests/test_new.py" },
        { status: "D", file: "src/old.py" },
      ],
      isTest,
    ),
    undefined,
  );
  const violation = checkExistingTests(
    [
      { status: "M", file: "tests/test_a.py" },
      { status: "D", file: "tests/test_b.py" },
      { status: "T", file: "tests/test_c.py" },
    ],
    isTest,
  );
  assert.match(violation, /tests\/test_a\.py \(modified\), tests\/test_b\.py \(deleted\), tests\/test_c\.py \(modified\)/);

  // Limitation 36 (catch2): the project's list of tests is a file under tests/; a line added there is allowed.
  const list = { status: "M", file: "tests/CMakeLists.txt" };
  assert.equal(checkExistingTests([list], isTest, (file) => file === "tests/CMakeLists.txt"), undefined);
  const deleted = checkExistingTests([list, { status: "D", file: "tests/test_b.py" }], isTest, () => true);
  assert.match(deleted, /deleted: tests\/test_b\.py \(deleted\)\./, "a deleted file never counts as lines added");

  const base = "set(TESTS\r\n  a.cpp\r\n  b.cpp\r\n)\r\n";
  assert.equal(onlyAddsLines(base, "set(TESTS\n  a.cpp\n  new.cpp\n  b.cpp\n)\n# more\n"), true, "line endings do not matter");
  assert.equal(onlyAddsLines(base, "set(TESTS\n  a.cpp\n)\n"), false, "a removed line");
  assert.equal(onlyAddsLines(base, "set(TESTS\n  a.cpp\n  b.cpp new.cpp\n)\n"), false, "a changed line");
  assert.equal(onlyAddsLines(base, "set(TESTS\n  b.cpp\n  a.cpp\n)\n"), false, "reordered lines");
  assert.equal(onlyAddsLines("a\na\n", "a\nb\n"), false, "a repeated line must be kept as often");
  assert.equal(onlyAddsLines("", "anything\n"), true);
  assert.match(violation, /put new tests in new lines or new files/);
});
