const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const { config } = require("../dist/config");
const { withProgress } = require("../dist/services/workspaceService");

const exec = promisify(execFile);
const node = (script) => exec(process.execPath, ["-e", script]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a long step reports progress with the end of its output, secrets masked, and waits for its last report", async (t) => {
  const saved = { ...config };
  t.after(() => Object.assign(config, saved));
  config.executionProgressIntervalSeconds = 1;
  config.executionHungAfterSeconds = 0;

  const reports = [];
  let writing = 0;
  const report = async (progress) => {
    writing++;
    await sleep(300); // a slow database write
    reports.push(progress);
    writing--;
  };
  const result = await withProgress(
    node("console.log('token s3cr3t-value-1'); setInterval(() => console.log('working'), 200); setTimeout(() => process.exit(0), 2600)"),
    { report, step: "setup", command: ["sh", "-c", "make deps"] },
    ["s3cr3t-value-1"],
  );
  assert.equal(writing, 0, "no report is still being written when the step returns");
  assert.match(result.stdout, /s3cr3t-value-1/, "the step's own result is unchanged");
  assert.ok(reports.length >= 2, `reported about once a second (${reports.length})`);
  const last = reports.at(-1);
  assert.equal(last.step, "setup");
  assert.equal(last.command, "make deps");
  assert.ok(last.elapsedSeconds >= 2);
  assert.equal(last.possiblyHung, false, "hung detection is off");
  assert.match(last.output, /token \*\*\*[\s\S]*working/);
  assert.doesNotMatch(JSON.stringify(reports), /s3cr3t-value-1/);
});

test("a step with no new output is reported as possibly hung; a failing report never fails it", async (t) => {
  const saved = { ...config };
  t.after(() => Object.assign(config, saved));
  config.executionProgressIntervalSeconds = 1;
  config.executionHungAfterSeconds = 1;

  const reports = [];
  await withProgress(
    node("console.log('started'); setTimeout(() => {}, 2600)"),
    { report: async (progress) => { reports.push(progress); throw new Error("database down"); }, step: "check", check: "test", command: ["npm", "test"] },
  );
  const last = reports.at(-1);
  assert.equal(last.check, "test");
  assert.ok(last.silentSeconds >= 1 && last.possiblyHung, "silent since 'started'");

  await assert.rejects(
    withProgress(node("process.exit(3)"), { report: async () => {}, step: "check", command: ["false"] }),
    (error) => error.code === 3,
    "the command's own failure comes through",
  );

  config.executionProgressIntervalSeconds = 0;
  const off = [];
  await withProgress(node("setTimeout(() => {}, 1500)"), { report: async (p) => off.push(p), step: "setup", command: ["x"] });
  assert.equal(off.length, 0, "0 turns reporting off");
});

test(
  "setup and the checks before the change report their progress",
  { skip: spawnSync("docker", ["version"]).status === 0 ? false : "Docker is not available" },
  async (t) => {
    const saved = { ...config };
    t.after(() => Object.assign(config, saved));
    config.executionProgressIntervalSeconds = 1;
    const { removeEnvironmentSnapshot, setupWorkspace, workspacePath } = require("../dist/services/workspaceService");
    const id = `progress-${crypto.randomUUID()}`;
    fs.mkdirSync(workspacePath(id), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: workspacePath(id) });
    if (spawnSync("docker", ["image", "inspect", "alpine:3.20"]).status !== 0) spawnSync("docker", ["pull", "alpine:3.20"]);
    t.after(async () => {
      await removeEnvironmentSnapshot(id);
      fs.rmSync(workspacePath(id), { recursive: true, force: true });
    });

    const reports = [];
    await setupWorkspace(
      id,
      { image: "alpine:3.20", env: {}, setup: ["sh", "-c", 'echo "using $REGISTRY_TOKEN"; sleep 2.5; echo installed'] },
      [{ name: "test", command: ["sh", "-c", "echo testing; sleep 2.5"] }],
      { secrets: { REGISTRY_TOKEN: "registry-token-value" }, progress: async (progress) => reports.push(progress) },
    );
    const setup = reports.filter((progress) => progress.step === "setup");
    const baseline = reports.filter((progress) => progress.step === "baseline");
    assert.ok(setup.length && baseline.length, JSON.stringify(reports));
    assert.match(setup.at(-1).output, /using \*\*\*/);
    assert.equal(baseline.at(-1).check, "test");
    assert.match(baseline.at(-1).output, /testing/);
    assert.doesNotMatch(JSON.stringify(reports), /registry-token-value/);
  },
);
