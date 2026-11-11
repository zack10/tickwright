const assert = require("node:assert/strict");
const test = require("node:test");

const {
  describeEnvironment,
  describeToolchain,
  isTestFile,
  parseVerificationConfig,
  resolveToolchain,
  selectChecks,
} = require("../dist/services/toolchain");
const { parseJsonc } = require("../dist/services/toolchain/devcontainer");
const { config } = require("../dist/config");
const { UNBUILT_IMAGE } = require("../dist/services/toolchain");

/** An in-memory repository: { "path": "content" }. */
const repo = (files) => (file) => files[file];
const resolve = (files, verificationConfig = {}) => resolveToolchain(repo(files), verificationConfig);

const NODE_ENVIRONMENT = {
  toolchain: {
    image: "node:20-bookworm",
    setup: ["npm", "ci", "--ignore-scripts"],
    checks: { test: ["npm", "test"] },
    protectedPaths: ["package.json", "package-lock.json"],
  },
};

test("with nothing defined, any project gets the default image and no checks", () => {
  for (const files of [{ "pom.xml": "<project/>" }, { "composer.json": "{}" }, { "main.c": "" }, {}]) {
    const { toolchain, source, notes } = resolve(files);
    assert.equal(source, "default");
    assert.equal(toolchain.image, config.executionDefaultImage);
    assert.equal(toolchain.setup, null);
    assert.deepEqual(toolchain.checks, {});
    assert.deepEqual(toolchain.env, {});
    assert.ok(notes.some((note) => /no checks are configured/.test(note)));
  }
  assert.match(describeToolchain(resolve({}).toolchain), /checks: none available/);
});

test("the repository's configuration is used as configured", () => {
  const { toolchain, source, notes } = resolve({ "package.json": "{}" }, NODE_ENVIRONMENT);
  assert.equal(source, "configured");
  assert.equal(toolchain.image, "node:20-bookworm");
  assert.deepEqual(toolchain.setup, ["npm", "ci", "--ignore-scripts"]);
  assert.deepEqual(toolchain.checks, { test: ["npm", "test"] });
  assert.deepEqual(toolchain.protectedPaths, ["package.json", "package-lock.json"]);
  assert.deepEqual(notes, []);
});

const DEVCONTAINER = `{
  // The project's own environment.
  "image": "mcr.microsoft.com/devcontainers/php:8.3",
  "features": { "ghcr.io/devcontainers/features/node:1": {} },
  "containerEnv": { "APP_ENV": "testing", "PATH": "\${containerEnv:PATH}:/extra" },
  "onCreateCommand": "composer install --no-interaction",
  "postCreateCommand": { "assets": ["npm", "ci"], "url": "echo 'http://x/*y*/'" }, /* trailing comma: */
}`;

test("the project's devcontainer gives the image, env and setup, and reports what it skipped", () => {
  const { toolchain, source, reason, notes } = resolve({ ".devcontainer/devcontainer.json": DEVCONTAINER });
  assert.equal(source, "devcontainer");
  assert.match(reason, /built from the project's \.devcontainer\/devcontainer\.json/, "features need a build");
  assert.equal(toolchain.image, UNBUILT_IMAGE);
  assert.deepEqual(toolchain.build, { config: ".devcontainer/devcontainer.json", inputs: [".devcontainer/devcontainer.json"] });
  const plain = resolve({ ".devcontainer.json": '{ "image": "mcr.microsoft.com/devcontainers/php:8.3" }' }).toolchain;
  assert.equal(plain.image, "mcr.microsoft.com/devcontainers/php:8.3", "a plain image is used as it is");
  assert.equal(plain.build, undefined);
  assert.equal(toolchain.env.APP_ENV, "testing");
  assert.equal(toolchain.env.PATH, undefined, "variables need a running dev container");
  assert.deepEqual(toolchain.setup, [
    "sh",
    "-c",
    "composer install --no-interaction && npm ci && echo 'http://x/*y*/'",
  ]);
  assert.ok(notes.some((note) => /containerEnv\.PATH was not applied/.test(note)));
});

test("configuration wins over the devcontainer field by field", () => {
  const configured = resolve(
    { ".devcontainer.json": '{ "image": "python:3.12", "postCreateCommand": "pip install -e ." }' },
    { toolchain: { checks: { test: ["pytest", "-q"] } } },
  );
  assert.equal(configured.source, "devcontainer", "no configured image: the project's is used");
  assert.deepEqual(configured.toolchain.setup, ["sh", "-c", "pip install -e ."]);
  assert.deepEqual(configured.toolchain.checks, { test: ["pytest", "-q"] });

  const image = resolve({ ".devcontainer.json": '{ "image": "python:3.12" }' }, { toolchain: { image: "python:3.13" } });
  assert.equal(image.source, "configured");
  assert.equal(image.toolchain.image, "python:3.13");
});

test("a devcontainer's Dockerfile is built, with paths relative to devcontainer.json", () => {
  const { toolchain, source, reason } = resolve({
    ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "1" } }, "postCreateCommand": "make deps" }',
  });
  assert.equal(source, "devcontainer");
  assert.match(reason, /built from the project's \.devcontainer\/devcontainer\.json/);
  assert.deepEqual(toolchain.build, {
    config: ".devcontainer/devcontainer.json",
    inputs: [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "."],
  });
  assert.equal(toolchain.image, UNBUILT_IMAGE);
  assert.deepEqual(toolchain.setup, ["sh", "-c", "make deps"]);
  assert.match(describeEnvironment(toolchain, [], false), /Image: built from the project's \.devcontainer\/devcontainer\.json/);

  const legacy = resolve({ ".devcontainer/devcontainer.json": '{ "dockerFile": "Dockerfile" }' }).toolchain.build;
  assert.deepEqual(legacy.inputs, [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", ".devcontainer"], "context defaults to its folder");

  const local = resolve({ ".devcontainer/devcontainer.json": '{ "image": "alpine:3.20", "features": { "./tools": {} } }' }).toolchain.build;
  assert.deepEqual(local.inputs, [".devcontainer/devcontainer.json", ".devcontainer/tools"], "a local feature is an input");

  const noBase = resolve({ ".devcontainer/devcontainer.json": '{ "features": { "./tools": {} } }' });
  assert.equal(noBase.toolchain.build, undefined, "features alone have nothing to build on");

  const configured = resolve({ ".devcontainer.json": '{ "build": { "dockerfile": "Dockerfile" } }' }, { toolchain: { image: "python:3.13" } });
  assert.equal(configured.toolchain.image, "python:3.13", "a configured image wins and nothing is built");
  assert.equal(configured.toolchain.build, undefined);
});

const COMPOSE_DEVCONTAINER =
  '{ "dockerComposeFile": ["compose.yml", "compose.override.yml"], "service": "app", "runServices": ["app", "db", "cache", "worker", "Bad_Name"] }';
const COMPOSE = [
  "services:",
  "  app:",
  "    build: { context: .., dockerfile: .devcontainer/Dockerfile }",
  "    environment:",
  "      - APP_MODE=test",
  "      - DATABASE_URL=postgres://postgres:${PG_PW:-secret}@db/app",
  "      - FROM_HOST",
  "  db:",
  "    image: postgres:16-alpine",
  '    environment: { POSTGRES_PASSWORD: "${PG_PW:-secret}", COST: "$$5", HOST_VALUE: "${HOME}" }',
  '    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"] }',
  "  cache:",
  "    image: redis:7",
  '    healthcheck: { test: ["CMD", "redis-cli", "ping"] }',
  "  worker:",
  "    build: .",
  "  Bad_Name:",
  "    image: busybox",
  "  docs:",
  "    image: nginx",
].join("\n");

test("a Compose devcontainer builds its service and starts the others beside the run", () => {
  const { toolchain, source, notes } = resolve({
    ".devcontainer/devcontainer.json": COMPOSE_DEVCONTAINER,
    ".devcontainer/compose.yml": COMPOSE,
    ".devcontainer/compose.override.yml": "services:\n  cache:\n    image: redis:7-alpine\n",
  });
  assert.equal(source, "devcontainer");
  assert.deepEqual(toolchain.build.inputs, [
    ".devcontainer/devcontainer.json",
    ".devcontainer/compose.yml",
    ".devcontainer/compose.override.yml",
    ".",
    ".devcontainer/Dockerfile",
  ]);
  assert.deepEqual(toolchain.env, { APP_MODE: "test", DATABASE_URL: "postgres://postgres:secret@db/app" });
  assert.deepEqual(
    toolchain.services,
    [
      { name: "db", image: "postgres:16-alpine", env: { POSTGRES_PASSWORD: "secret", COST: "$5" }, ready: ["sh", "-c", "pg_isready -U postgres"] },
      { name: "cache", image: "redis:7-alpine", ready: ["redis-cli", "ping"] },
    ],
    "runServices limits them; the override file wins; only defaults fill variables",
  );
  for (const expected of [/app environment FROM_HOST was not applied/, /db environment HOST_VALUE was not applied/, /worker was not started/, /Bad_Name \(busybox\) was not started/])
    assert.ok(notes.some((note) => expected.test(note)), `${expected} in ${notes.join("; ")}`);

  const configured = resolve(
    { ".devcontainer/devcontainer.json": COMPOSE_DEVCONTAINER, ".devcontainer/compose.yml": COMPOSE, ".devcontainer/compose.override.yml": "" },
    { toolchain: { services: [{ name: "pg", image: "postgres:16" }] } },
  );
  assert.deepEqual(configured.toolchain.services, [{ name: "pg", image: "postgres:16" }], "configured services replace Compose's");
});

test("a devcontainer that would build from outside the repository is not built", () => {
  const compose = (yaml) => ({ ".devcontainer/devcontainer.json": '{ "dockerComposeFile": "c.yml", "service": "app" }', ".devcontainer/c.yml": yaml });
  const cases = {
    "context outside": { ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile", "context": "../.." } }' },
    "build options": { ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile", "options": ["--secret", "id=k,src=/etc/shadow"] } }' },
    "compose file outside": { ".devcontainer/devcontainer.json": '{ "dockerComposeFile": "../../compose.yml", "service": "app" }' },
    "compose context outside": compose("services:\n  app:\n    build: ../../..\n"),
    "compose build secrets": compose("services:\n  app:\n    build: { context: ., secrets: [k] }\n"),
    "compose include": compose("include: [../../x.yml]\nservices: {}\n"),
    "missing service": compose("services:\n  web:\n    image: nginx\n"),
    "compose build cache": compose("services:\n  app:\n    build: { context: ., cache_from: [type=local,src=/home] }\n"),
    "compose env_file outside": compose("services:\n  app:\n    image: alpine\n  db:\n    image: postgres\n    env_file: ../../../etc/env\n"),
    "compose extends outside": compose("services:\n  app:\n    image: alpine\n  db:\n    extends: { file: /etc/compose.yml, service: x }\n"),
    "local feature outside": { ".devcontainer/devcontainer.json": '{ "image": "alpine:3.20", "features": { "../../feature": {} } }' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const { toolchain, notes } = resolve(files);
    assert.equal(toolchain.build, undefined, name);
    assert.equal(toolchain.services, undefined, name);
    assert.ok(notes.some((note) => /so the devcontainer was not built/.test(note)), `${name}: ${notes.join("; ")}`);
  }
  assert.equal(resolve(cases["local feature outside"]).toolchain.image, "alpine:3.20", "its plain image is still used");
  assert.equal(resolve(cases["context outside"]).toolchain.image, config.executionDefaultImage);
});

test("a devcontainer that can't be used falls back to the default image and says why", () => {

  const broken = resolve({ ".devcontainer.json": "{ not json" });
  assert.equal(broken.source, "default");
  assert.ok(broken.notes.some((note) => /could not be parsed/.test(note)));

  const unsafe = resolve({ ".devcontainer.json": '{ "image": "--privileged" }' });
  assert.equal(unsafe.toolchain.image, config.executionDefaultImage);
  assert.ok(unsafe.notes.some((note) => /not a valid image reference/.test(note)));
});

test("JSONC parsing keeps comment-like text and commas inside strings", () => {
  assert.deepEqual(parseJsonc('{ "a": "x // y", "b": "/* z */", "c": "1,}", }'), { a: "x // y", b: "/* z */", c: "1,}" });
  assert.deepEqual(parseJsonc('[1, 2, /* three */ ]'), [1, 2]);
  assert.deepEqual(parseJsonc('{ "q": "say \\"hi\\" // not a comment" }'), { q: 'say "hi" // not a comment' });
});

test("invalid configuration is rejected as non-retryable", () => {
  const rejects = (verificationConfig, pattern) =>
    assert.throws(
      () => parseVerificationConfig(verificationConfig),
      (error) => error.name === "NonRetryableError" && pattern.test(error.message),
    );
  rejects({ toolchain: { image: "Bad Image!" } }, /invalid image reference/);
  rejects({ toolchain: { image: "--privileged" } }, /invalid image reference/);
  rejects({ toolchain: { testFilePatterns: ["(unclosed"] } }, /invalid regular expression/);
  rejects({ toolchain: { env: { "has-dash": "x" } } }, /toolchain\.env/);
  rejects({ toolchain: { preset: "node" } }, /Unrecognized key/);
  rejects({ unknown: true }, /Unrecognized key/);
  rejects({ toolchain: { services: [{ name: "DB", image: "postgres:16" }] } }, /toolchain\.services\.0\.name/);
  rejects({ toolchain: { services: [{ name: "db", image: "--privileged" }] } }, /invalid image reference/);
  rejects({ toolchain: { services: [{ name: "db", image: "a:1" }, { name: "db", image: "b:1" }] } }, /service names must be unique/);
  assert.deepEqual(parseVerificationConfig(null), {}, "no configuration is valid");
});

test("selected checks that the repository lacks are unavailable, not failed", () => {
  const { toolchain } = resolve({}, { toolchain: { checks: { build: ["make"], test: ["make", "test"] } } });
  assert.deepEqual(selectChecks(toolchain, {}).run.map((check) => check.name), ["build", "test"]);
  const selected = selectChecks(toolchain, { scripts: ["test", "lint"] });
  assert.deepEqual(selected.run, [{ name: "test", command: ["make", "test"] }]);
  assert.deepEqual(selected.unavailable, ["lint"]);
});

test("the plan says whether checks, discovery or nothing will verify the change", () => {
  const { planVerification } = require("../dist/services/toolchain");
  const configured = { toolchain: { checks: { test: ["make", "test"] } } };
  assert.equal(planVerification(resolve({}, configured).toolchain, configured, 3), "checks");
  assert.equal(planVerification(resolve({}).toolchain, {}, 3), "discovery", "no checks yet: discovery proposes them");
  assert.equal(planVerification(resolve({}).toolchain, {}, 0), "none", "discovery is off");
  const missing = { ...configured, scripts: ["lint"] };
  assert.equal(planVerification(resolve({}, missing).toolchain, missing, 3), "none", "only missing checks selected, and discovery does not run");
});

test("the agent is told the image and each check's command, or how to find them", () => {
  const { describeEnvironment } = require("../dist/services/toolchain");
  const { toolchain } = resolve({}, { toolchain: { image: "python:3.12", language: "Python", checks: { test: ["pytest", "-q"] } } });
  assert.equal(
    describeEnvironment(toolchain, selectChecks(toolchain, {}).run, true),
    "Language: Python\nImage: python:3.12\nChecks:\n- test: pytest -q",
  );
  const bare = resolve({}).toolchain;
  assert.match(describeEnvironment(bare, [], true), /none are configured.*use run_command/);
  assert.doesNotMatch(describeEnvironment(bare, [], false), /run_command/, "single-shot mode has no commands");
  assert.match(
    describeEnvironment(toolchain, selectChecks(toolchain, {}).run, true, ["test"]),
    /\nAlready failing before your change, on the unmodified code: test\. A failure there is not caused by you/,
  );
  const services = [{ name: "db", image: "postgres:16", env: { POSTGRES_PASSWORD: "test" }, ready: ["pg_isready"] }];
  const withDb = resolve({}, { toolchain: { services } }).toolchain;
  assert.deepEqual(withDb.services, services);
  assert.match(describeEnvironment(withDb, [], true), /\nServices, reachable by name from setup, checks and commands: db \(postgres:16\)\n/);
  assert.equal(resolve({}).toolchain.services, undefined, "no services unless configured");
});

test("containers get the repository's resource limits, else the defaults", () => {
  const { limitArgs } = require("../dist/services/workspaceService");
  assert.deepEqual(limitArgs(null), ["--cpus", "2", "--memory", "2048m", "--pids-limit", "256"]);
  assert.deepEqual(
    limitArgs({ sandboxCpus: 4, sandboxMemoryMb: 8192, sandboxMaxProcesses: 1024, maxChangedFiles: 20 }),
    ["--cpus", "4", "--memory", "8192m", "--pids-limit", "1024"],
  );
});

test("the PR body says which checks ran, and when none did", () => {
  const { describeVerification } = require("../dist/services/workspaceService");
  const verified = describeVerification({
    checksRun: 2,
    results: [
      { script: "typecheck", passed: true, unavailable: true, output: "" },
      { script: "lint", passed: true, output: "" },
      { script: "test", passed: true, output: "" },
    ],
  });
  assert.match(verified, /^Checks passed: lint, test\./);
  assert.match(verified, /Not available in this repository: typecheck\./);

  assert.match(describeVerification({ checksRun: 0, results: [] }), /\*\*Unverified:\*\*/);
  assert.match(describeVerification(null), /\*\*Unverified:\*\*/, "no metadata proves nothing");
  assert.match(
    describeVerification({ passed: true, results: [{ script: "test", passed: true, output: "" }] }),
    /^Checks passed: test\./,
    "artifacts from before toolchains",
  );

  const objected = describeVerification({
    checksRun: 1,
    results: [{ script: "test", passed: true, output: "" }],
    reviewObjections: ["NextRun is\n unchanged"],
  });
  assert.match(objected, /^\*\*The reviewer objected to this change\.\*\*/, "objections come first");
  assert.match(objected, /^- NextRun is unchanged$/m);
  assert.match(objected, /Checks passed: test\./);

  const before = describeVerification({
    checksRun: 2,
    results: [
      { script: "lint", passed: true, output: "" },
      { script: "test", passed: false, failingBefore: true, output: "1 failing" },
    ],
  });
  assert.match(before, /^Checks passed: lint\.\n\*\*Already failing before this change:\*\* test\. It failed on the unmodified code too/);
  assert.match(
    describeVerification({ checksRun: 1, results: [{ script: "test", passed: false, failingBefore: true, output: "" }] }),
    /^No check passed\.\n\*\*Already failing before this change:\*\* test\./,
    "an already-failing check is never reported as passed",
  );
});

test("the plan and PR say when no test names the changed code", () => {
  const { testCoverage, describeTestCoverage } = require("../dist/services/toolchain");
  const { describeVerification } = require("../dist/services/workspaceService");
  const { toolchain } = resolve({});
  const files = {
    "pkg/parse.go": "",
    "pkg/parse_test.go": "package pkg",
    "app/billing.py": "",
    "app/report.py": "",
    "tests/test_misc.py": "from app.billing import total",
  };
  const coverage = testCoverage(toolchain, Object.keys(files), repo(files), [
    "pkg/parse.go",
    "app/billing.py",
    "app/report.py",
    "tests/test_misc.py",
  ]);
  assert.deepEqual(coverage, { testFiles: 2, untested: ["app/report.py"] }, "named by path or contents; test files themselves are never untested");
  assert.match(describeTestCoverage(coverage), /^\*\*No test names this file:\*\* app\/report\.py\./);
  assert.equal(describeTestCoverage({ testFiles: 3, untested: [] }), "");
  assert.equal(describeTestCoverage(undefined), "", "artifacts from before coverage");
  assert.match(describeTestCoverage(testCoverage(toolchain, ["a.rs"], repo({}), ["a.rs"])), /^\*\*No tests:\*\*/);

  const passed = { checksRun: 1, results: [{ script: "test", passed: true, output: "" }] };
  assert.match(describeVerification({ ...passed, testCoverage: coverage }), /Checks passed: test\.\n\*\*No test names this file:\*\*/);
  assert.doesNotMatch(describeVerification({ checksRun: 0, results: [], testCoverage: coverage }), /No test names/, "Unverified already says it");
});

test("verification does not block on a check that already failed before the change", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const { verifyWorkspace, workspacePath } = require("../dist/services/workspaceService");
  const id = `verify-test-${process.pid}`;
  const dir = workspacePath(id);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const toolchain = { image: "node:20-bookworm", env: {} };
  const check = (name, script) => ({ name, command: ["sh", "-c", script] });

  const tolerated = await verifyWorkspace(
    id,
    toolchain,
    { run: [check("test", "echo old failure; exit 1"), check("lint", "echo fine")], unavailable: [] },
    ["test"],
  );
  assert.equal(tolerated.passed, true);
  assert.deepEqual(
    tolerated.results.map(({ script, passed, failingBefore }) => ({ script, passed, failingBefore })),
    [
      { script: "test", passed: false, failingBefore: true },
      { script: "lint", passed: true, failingBefore: undefined },
    ],
    "the failure is recorded and the next check still runs",
  );

  const broken = await verifyWorkspace(id, toolchain, { run: [check("lint", "exit 2"), check("test", "true")], unavailable: [] }, ["test"]);
  assert.equal(broken.passed, false, "a check that passed before still blocks");
  assert.deepEqual(broken.results.map((result) => result.script), ["lint"]);

  // Fails the first time only: the marker file survives between the two runs.
  const flaky = await verifyWorkspace(
    id,
    toolchain,
    { run: [check("test", "if [ -f .ran ]; then echo second; else touch .ran; echo first; exit 1; fi"), check("lint", "true")], unavailable: [] },
  );
  assert.equal(flaky.passed, true, "a check that passes when run again does not block");
  assert.deepEqual(
    flaky.results.map(({ script, passed, flaky }) => ({ script, passed, flaky })),
    [
      { script: "test", passed: true, flaky: true },
      { script: "lint", passed: true, flaky: undefined },
    ],
  );
  assert.match(flaky.results[0].output, /First run failed:[\s\S]*Second run passed:[\s\S]*second/);
});

test("Docker image changes run one at a time, and a failed one does not block the next", async () => {
  const { withImageLock } = require("../dist/services/workspaceService");
  const order = [];
  const step = (name, ms, fail) =>
    withImageLock(async () => {
      order.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name} end`);
      if (fail) throw new Error(name);
      return name;
    });
  const results = await Promise.allSettled([step("commit", 30), step("rmi", 1, true), step("tag", 1)]);
  assert.deepEqual(order, ["commit start", "commit end", "rmi start", "rmi end", "tag start", "tag end"]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(results[2].value, "tag");
});

test("the PR says which checks failed once and then passed", () => {
  const { describeVerification } = require("../dist/services/workspaceService");
  const text = describeVerification({
    checksRun: 2,
    results: [
      { script: "test", passed: true, flaky: true, output: "" },
      { script: "lint", passed: true, output: "" },
    ],
  });
  assert.match(text, /^Checks passed: test, lint\.\n\*\*Failed once, then passed:\*\* test\. This check/);
  assert.doesNotMatch(describeVerification({ checksRun: 1, results: [{ script: "test", passed: true, output: "" }] }), /Failed once/);
});

test("checks reach the run's services by name, and nothing else", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const {
    execInSandbox,
    removeEnvironmentSnapshot,
    removeServices,
    setupWorkspace,
    startSandbox,
    stopSandbox,
    verifyWorkspace,
    workspacePath,
  } = require("../dist/services/workspaceService");
  const id = `services-test-${process.pid}`;
  const dir = workspacePath(id);
  fs.mkdirSync(dir, { recursive: true });
  t.after(async () => {
    await removeServices(id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const toolchain = {
    image: "node:20-bookworm",
    env: {},
    services: [{ name: "web", image: "nginx:1.27-alpine", ready: ["wget", "-q", "-O", "/dev/null", "http://localhost"] }],
  };
  const check = (name, script) => ({ name, command: ["sh", "-c", script] });

  const result = await verifyWorkspace(id, toolchain, {
    run: [check("service", "curl -sf -m 10 http://web >/dev/null"), check("internet", "! curl -sf -m 5 https://example.com >/dev/null")],
    unavailable: [],
  });
  assert.equal(result.passed, true, result.results.map((r) => r.output).join("\n"));

  // Setup (on the bridge too, for package registries) and the agent's sandbox reach it the same way.
  const setup = await setupWorkspace(id, { ...toolchain, setup: null }, [check("service", "curl -sf -m 10 http://web >/dev/null")]);
  assert.deepEqual(setup.baseline.map(({ check, passed }) => ({ check, passed })), [{ check: "service", passed: true }]);
  await startSandbox(id, toolchain);
  try {
    assert.equal((await execInSandbox(id, ["curl", "-sf", "-m", "10", "http://web"], 30_000)).exitCode, 0);
    assert.notEqual((await execInSandbox(id, ["curl", "-sf", "-m", "5", "https://example.com"], 30_000)).exitCode, 0);
  } finally {
    await stopSandbox(id);
  }

  await removeEnvironmentSnapshot(id);
  await removeServices(id);
  const left = execFileSync("docker", ["ps", "-aq", "--filter", `label=agent.services=${id}`], { encoding: "utf8" }).trim();
  assert.equal(left, "", "service containers are removed");
  assert.notEqual(require("node:child_process").spawnSync("docker", ["network", "inspect", `agent-net-${id}`]).status, 0, "the network is removed");
});

test("a new environment cache replaces the repository's old one", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const { removeEnvironmentSnapshot, setupWorkspace, workspacePath } = require("../dist/services/workspaceService");
  const scope = `cache-test-${process.pid}`;
  const images = (...args) => execFileSync("docker", ["images", ...args], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const run = async (id, setup) => {
    fs.mkdirSync(workspacePath(id), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: workspacePath(id) });
    const result = await setupWorkspace(id, { image: "alpine:3.20", env: {}, setup: ["sh", "-c", setup] }, [], { cacheFor: scope });
    await removeEnvironmentSnapshot(id);
    fs.rmSync(workspacePath(id), { recursive: true, force: true });
    return result.cache;
  };
  t.after(() => {
    for (const image of images(`agent-cache-${scope}`, "--format", "{{.Repository}}:{{.Tag}}"))
      execFileSync("docker", ["rmi", "-f", image]);
  });

  assert.equal(await run(`${scope}-a`, "echo a > /a"), "built");
  assert.equal(await run(`${scope}-b`, "echo b > /b"), "built");
  assert.equal(images(`agent-cache-${scope}`, "-q").length, 1, "only the new cache is kept");
  assert.deepEqual(images("-q", "--filter", "dangling=true", "--filter", `label=agent.environment-cache=agent-cache-${scope}`), []);
});

test("the project's devcontainer is built with its features, and nothing reaches or runs on the host", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync, spawnSync } = require("node:child_process");
  const { buildEnvironmentImage, SetupFailedError, workspacePath } = require("../dist/services/workspaceService");
  const id = `build-test-${process.pid}`;
  const scope = `build-scope-${process.pid}`;
  const dir = workspacePath(id);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const images = () => execFileSync("docker", ["images", `agent-build-${scope}`, "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  process.env.SECRET_PROBE = "app-secret-value";
  t.after(() => {
    delete process.env.SECRET_PROBE;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const image of images()) spawnSync("docker", ["rmi", "-f", image]);
  });
  execFileSync("git", ["init", "-q"], { cwd: (fs.mkdirSync(dir, { recursive: true }), dir) });
  write("hello.txt", "from the context\n");
  write(".devcontainer/Dockerfile", 'FROM alpine:3.20\nARG S\nCOPY hello.txt /hello.txt\nRUN echo "s=$S" >> /hello.txt\n');
  write(".devcontainer/devcontainer.json", JSON.stringify({
    build: { dockerfile: "Dockerfile", context: "..", args: { S: "${localEnv:SECRET_PROBE}" } },
    initializeCommand: "echo ran > initialize-ran.txt",
    features: { "ghcr.io/devcontainers/features/common-utils:2": { installZsh: false, installOhMyZsh: false } },
  }));
  const build = { config: ".devcontainer/devcontainer.json", inputs: [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "."] };

  const image = await buildEnvironmentImage(id, scope, build);
  assert.match(image, new RegExp(`^agent-build-${scope}:[0-9a-f]{32}$`));
  assert.equal(execFileSync("docker", ["run", "--rm", image, "cat", "/hello.txt"], { encoding: "utf8" }), "from the context\ns=\n", "the app's environment is not the build's");
  assert.equal(spawnSync("docker", ["run", "--rm", image, "which", "jq"]).status, 0, "the feature is installed");
  assert.equal(fs.existsSync(path.join(dir, "initialize-ran.txt")), false, "initializeCommand does not run on the host");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).split("\n").filter((line) => line && !/hello\.txt|\.devcontainer\//.test(line)).length, 0, "nothing is written into the clone");
  assert.equal(await buildEnvironmentImage(id, scope, build), image, "an unchanged rebuild is the same image");

  // Compose: the main service's build, without starting anything.
  write(".devcontainer/devcontainer.json", JSON.stringify({ dockerComposeFile: "compose.yml", service: "app" }));
  write(".devcontainer/compose.yml", "services:\n  app:\n    build: { context: .., dockerfile: .devcontainer/Dockerfile }\n    command: sleep infinity\n  db:\n    image: postgres:16-alpine\n");
  const composed = await buildEnvironmentImage(id, scope, { config: ".devcontainer/devcontainer.json", inputs: [".devcontainer/compose.yml", ".", ".devcontainer/Dockerfile"] });
  assert.match(execFileSync("docker", ["run", "--rm", composed, "cat", "/hello.txt"], { encoding: "utf8" }), /from the context/);

  write(".devcontainer/devcontainer.json", JSON.stringify({ build: { dockerfile: "Dockerfile" } }));
  write(".devcontainer/Dockerfile", "FROM alpine:3.20\nRUN echo broken-step-output && exit 3\n");
  await assert.rejects(
    buildEnvironmentImage(id, scope, { config: ".devcontainer/devcontainer.json", inputs: [".devcontainer/Dockerfile"] }),
    (error) => error instanceof SetupFailedError && /broken-step-output/.test(error.message),
  );
});

test("test secrets reach every check (baseline, sandbox, verification), never setup or the snapshot, and are masked", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const { execInSandbox, removeEnvironmentSnapshot, setupWorkspace, startSandbox, stopSandbox, verifyWorkspace, workspacePath } = require("../dist/services/workspaceService");
  const id = `test-secrets-${process.pid}`;
  fs.mkdirSync(workspacePath(id), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspacePath(id) });
  t.after(async () => {
    await stopSandbox(id);
    await removeEnvironmentSnapshot(id);
    fs.rmSync(workspacePath(id), { recursive: true, force: true });
  });
  const value = "test-secret-value-42";
  const testSecrets = { PAYMENTS_TEST_KEY: value };
  const sh = (script) => ["sh", "-c", script];
  const check = { name: "test", command: sh(`test "$PAYMENTS_TEST_KEY" = ${value} && echo "key is $PAYMENTS_TEST_KEY"`) };
  const toolchain = { image: "alpine:3.20", env: {}, setup: sh('test -z "$PAYMENTS_TEST_KEY"') };

  const setup = await setupWorkspace(id, toolchain, [check], { testSecrets });
  assert.deepEqual(setup.baseline.map(({ passed }) => passed), [true], setup.baseline[0]?.output);
  assert.match(setup.baseline[0].output, /key is \*\*\*/);
  assert.doesNotMatch(setup.baseline[0].output, new RegExp(value));
  const snapshot = execFileSync("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", setup.image], { encoding: "utf8" });
  assert.doesNotMatch(snapshot, /PAYMENTS_TEST_KEY|test-secret-value-42/, "the snapshot does not keep it");

  const built = { ...toolchain, image: setup.image, setup: null };
  await startSandbox(id, built, null, testSecrets);
  const inSandbox = await execInSandbox(id, check.command, 30_000, Object.values(testSecrets));
  assert.equal(inSandbox.exitCode, 0, inSandbox.output);
  assert.match(inSandbox.output, /key is \*\*\*/);

  const verified = await verifyWorkspace(id, built, { run: [check], unavailable: [] }, [], undefined, null, testSecrets);
  assert.equal(verified.passed, true, JSON.stringify(verified.results));
  assert.match(verified.results[0].output, /key is \*\*\*/);
  assert.doesNotMatch(verified.results[0].output, new RegExp(value));
  const without = await verifyWorkspace(id, built, { run: [check], unavailable: [] });
  assert.equal(without.passed, false, "a check without the secret does not see one");
});

test("setup secrets reach the setup command only, never the checks or the snapshot, and are masked", { skip: require("node:child_process").spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" }, async (t) => {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const { removeEnvironmentSnapshot, setupWorkspace, SetupFailedError, workspacePath } = require("../dist/services/workspaceService");
  const id = `secrets-test-${process.pid}`;
  fs.mkdirSync(workspacePath(id), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspacePath(id) });
  t.after(async () => {
    await removeEnvironmentSnapshot(id);
    fs.rmSync(workspacePath(id), { recursive: true, force: true });
  });
  const secrets = { REGISTRY_TOKEN: "registry-secret-value-9" };
  const sh = (script) => ["sh", "-c", script];
  const toolchain = { image: "alpine:3.20", env: {}, setup: sh('test "$REGISTRY_TOKEN" = registry-secret-value-9 && touch /setup-saw-it') };

  const result = await setupWorkspace(id, toolchain, [{ name: "check", command: sh('test -f /setup-saw-it && test -z "$REGISTRY_TOKEN"') }], { secrets });
  assert.deepEqual(result.baseline.map(({ passed }) => passed), [true], result.baseline[0]?.output);
  const snapshot = execFileSync("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", result.image], { encoding: "utf8" });
  assert.doesNotMatch(snapshot, /registry-secret-value-9|REGISTRY_TOKEN/, "the snapshot does not keep it");
  assert.doesNotMatch(execFileSync("docker", ["run", "--rm", result.image, "env"], { encoding: "utf8" }), /registry-secret-value-9/);

  await assert.rejects(
    setupWorkspace(id, { ...toolchain, setup: sh('echo "token is $REGISTRY_TOKEN"; exit 1') }, [], { secrets }),
    (error) => error instanceof SetupFailedError && /token is \*\*\*/.test(error.message) && !error.message.includes("registry-secret-value-9"),
  );
});

test("environment snapshots are cached per repository and per environment", () => {
  const { environmentCacheImage } = require("../dist/services/workspaceService");
  const toolchain = { image: "example/runtime:1", setup: ["sh", "-c", "make deps"], env: { A: "1", B: "2" } };
  const checks = [{ name: "test", command: ["make", "test"] }];
  const image = environmentCacheImage("Repo-1", toolchain, checks);
  assert.match(image, /^agent-cache-repo-1:[0-9a-f]{32}$/, "a valid docker reference");
  assert.equal(environmentCacheImage("Repo-1", { ...toolchain, env: { B: "2", A: "1" } }, checks), image, "env order does not matter");

  const other = [
    environmentCacheImage("repo-2", toolchain, checks),
    environmentCacheImage("Repo-1", { ...toolchain, image: "example/runtime:2" }, checks),
    environmentCacheImage("Repo-1", { ...toolchain, setup: null }, checks),
    environmentCacheImage("Repo-1", { ...toolchain, env: { A: "1" } }, checks),
    environmentCacheImage("Repo-1", toolchain, [{ name: "test", command: ["make", "check"] }]),
  ];
  assert.equal(new Set([image, ...other]).size, 6, "any change to the environment is another cache");
  assert.throws(() => environmentCacheImage("../x", toolchain, checks), /Unsafe workspace id/);
});

test("a cached snapshot is reused only while it is younger than the limit", () => {
  const { isFresh } = require("../dist/services/workspaceService");
  const now = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(isFresh("2026-10-27T01:00:00.123456789Z", 24, now), true);
  assert.equal(isFresh("2026-10-26T11:59:00Z", 24, now), false);
  assert.equal(isFresh("not a date", 24, now), false);
});

test("default test-file patterns follow common conventions across ecosystems", () => {
  const { toolchain } = resolve({});
  const cases = [
    ["src/a.test.ts", true],
    ["__tests__/a.js", true],
    ["tests/test_api.py", true],
    ["app/models_test.py", true],
    ["pkg/api_test.go", true],
    ["src/test/java/com/x/AppTest.java", true],
    ["tests/Feature/UserTest.php", true],
    ["spec/models/user_spec.rb", true],
    ["Api.Tests/UserTests.cs", true],
    ["src/main/java/com/x/App.java", false],
    ["app/Models/User.php", false],
    ["src/contest.js", false],
    ["src/Latest.cs", false],
    ["pkg/api.go", false],
  ];
  for (const [file, expected] of cases) assert.equal(isTestFile(toolchain, file), expected, file);
  const custom = resolve({}, { toolchain: { testFilePatterns: ["^checks/"] } }).toolchain;
  assert.equal(isTestFile(custom, "checks/a.sh"), true);
  assert.equal(isTestFile(custom, "src/a.test.ts"), false, "configured patterns replace the defaults");
});
