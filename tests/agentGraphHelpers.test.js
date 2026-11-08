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
} = require("../dist/services/agentGraph/repoContext");
const {
  checkExistingTests,
  checkRepositoryPolicy,
} = require("../dist/services/agentGraph/repoPolicy");
const {
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

test("existing tests may not be modified or deleted by any means; new tests may be added", () => {
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
  assert.match(violation, /add new test files instead/);
});
