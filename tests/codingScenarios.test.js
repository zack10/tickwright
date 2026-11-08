// Checks that every coding-benchmark scenario is valid before any LLM time is
// spent on it: each suite's clean project passes everything, and each planted
// bug passes the project's own tests but fails its hidden test by an
// assertion. Tests run in each suite's grader image, so Docker is needed;
// without it these tests are skipped.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  cleanFiles,
  diffStats,
  grade,
  graderCommand,
  isTestFile,
  loadScenarios,
  loadSuites,
  scenarioFiles,
} = require("./e2e/codingScenarios");

const suites = loadSuites();
const scenarios = loadScenarios();
const docker = spawnSync("docker", ["version"], { encoding: "utf8" }).status === 0;
const needsDocker = { skip: docker ? false : "Docker is not available" };

test("every suite has a language, an environment and at least 3 valid scenarios", () => {
  assert.deepEqual(suites.map((suite) => suite.name).sort(), ["go", "node", "python", "python-db"]);
  for (const suite of suites) {
    assert.ok(suite.language && suite.environment?.toolchain?.checks, `${suite.name}: language and environment`);
    assert.ok(suite.grader.image && suite.grader.test && suite.grader.hiddenTest, `${suite.name}: grader`);
    const own = scenarios.filter((scenario) => scenario.suite.name === suite.name);
    assert.ok(own.length >= 3, `${suite.name}: at least 3 scenarios`);
    const clean = cleanFiles(suite);
    for (const scenario of own) {
      assert.ok(scenario.title && scenario.description, `${scenario.id}: title and description`);
      assert.ok(["fix", "blocked"].includes(scenario.expect), `${scenario.id}: expect is fix or blocked`);
      for (const file of scenario.expectedFiles)
        assert.ok(clean.has(file), `${scenario.id}: expected file ${file} exists in the clean repo`);
      for (const file of scenario.bugFiles.keys()) {
        assert.ok(clean.has(file), `${scenario.id}: bug file ${file} replaces a clean file`);
        assert.ok(!isTestFile(suite, file), `${scenario.id}: bugs are planted in source, not tests`);
      }
      for (const file of scenario.hiddenFiles.keys()) {
        assert.ok(isTestFile(suite, file), `${scenario.id}: hidden file ${file} is a test file`);
        assert.ok(!clean.has(file), `${scenario.id}: hidden file ${file} does not replace a project file`);
      }
      if (scenario.expect === "fix") {
        assert.ok(scenario.hiddenFiles.size > 0, `${scenario.id}: has a hidden test`);
        assert.ok(scenario.bugFiles.size > 0, `${scenario.id}: plants a bug`);
      } else {
        assert.equal(scenario.hiddenFiles.size, 0, `${scenario.id}: blocked scenarios have no hidden test`);
      }
    }
  }
});

for (const suite of suites)
  test(`${suite.name}: the clean project passes its own tests and every hidden test`, needsDocker, async () => {
    const hidden = new Map(
      scenarios.filter((scenario) => scenario.suite.name === suite.name).flatMap((scenario) => [...scenario.hiddenFiles]),
    );
    const result = await grade(suite, cleanFiles(suite), hidden);
    assert.ok(result.visiblePassed, result.visibleOutput);
    assert.ok(result.hiddenPassed, result.hiddenOutput);
  });

for (const scenario of scenarios.filter((candidate) => candidate.expect === "fix"))
  test(`${scenario.id}: the bug passes the project's tests but fails the hidden test`, needsDocker, async () => {
    const result = await grade(scenario.suite, scenarioFiles(scenario), scenario.hiddenFiles);
    assert.ok(result.visiblePassed, `visible tests should not catch the bug:\n${result.visibleOutput}`);
    assert.equal(result.hiddenPassed, false, "the hidden test must catch the bug");
    // ...by an assertion, not because it crashed or did not compile.
    assert.match(result.hiddenOutput, new RegExp(scenario.suite.grader.assertionFailure, "m"), result.hiddenOutput);
  });

test("node/07: the bug sits beyond the 20 KB repo-context cut-off", () => {
  const scenario = scenarios.find((candidate) => candidate.id.startsWith("node/07-"));
  const source = scenario.bugFiles.get("src/shippingRates.js");
  assert.ok(Buffer.byteLength(source.slice(0, source.indexOf("function shippingCost"))) > 20_000);
});

test("grader commands take the hidden files where they ask for them", () => {
  assert.deepEqual(graderCommand(["node", "--test", "{files}"], ["a.js", "b.js"]), ["node", "--test", "a.js", "b.js"]);
  assert.deepEqual(graderCommand(["go", "test", "./..."], ["x_test.go"]), ["go", "test", "./..."]);
});

test("diffStats counts files and changed lines", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    "+extra",
    "diff --git a/src/b.js b/src/b.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.js",
    "+created",
  ].join("\n");
  assert.deepEqual(diffStats(diff), { files: ["src/a.js", "src/b.js"], editedFiles: ["src/a.js"], added: 3, removed: 1 });
});
