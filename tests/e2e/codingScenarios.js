// Coding benchmark scenarios (Phase 0 of docs/plans/AGENTIC_ROADMAP.md).
//
// coding-scenarios/<suite>/ is one project in one language: suite.json (the
// environment the sandbox repository runs with, and how a grader runs its
// tests), repo/ (the clean project) and one folder per scenario. Each scenario
// holds scenario.json (the ticket and what is expected), bug/ (files that
// replace the clean ones to plant the bug) and hidden/ (test files added at
// the same paths for grading only). Hidden files never leave this
// repository: the agent cannot see or edit them.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { removeServices, startServices } = require("../../dist/services/workspaceService");

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, "coding-scenarios");
// Applies the agent's diff; any image with git (the graders may not have it).
const PATCH_IMAGE = "node:20-bookworm";

const listFiles = (dir, prefix = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });

// LF only, so a Windows checkout (core.autocrlf) pushes the same bytes as any other.
const readText = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const readTree = (dir) =>
  fs.existsSync(dir) ? new Map(listFiles(dir).map((file) => [file, readText(path.join(dir, file))])) : new Map();

const loadSuites = () =>
  fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, entry.name, "suite.json")))
    .map((entry) => {
      const dir = path.join(ROOT, entry.name);
      return { name: entry.name, dir, ...JSON.parse(readText(path.join(dir, "suite.json"))) };
    });

/** Every scenario of every suite; ids are "<suite>/<NN-name>". */
const loadScenarios = () =>
  loadSuites().flatMap((suite) =>
    fs
      .readdirSync(suite.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{2}-/.test(entry.name))
      .map((entry) => {
        const dir = path.join(suite.dir, entry.name);
        return {
          id: `${suite.name}/${entry.name}`,
          suite,
          dir,
          ...JSON.parse(readText(path.join(dir, "scenario.json"))),
          bugFiles: readTree(path.join(dir, "bug")),
          hiddenFiles: readTree(path.join(dir, "hidden")),
        };
      }),
  );

/** A suite's clean project. */
const cleanFiles = (suite) => readTree(path.join(suite.dir, "repo"));

/** What the agent starts from: the clean project with the scenario's bug planted. */
const scenarioFiles = (scenario) => new Map([...cleanFiles(scenario.suite), ...scenario.bugFiles]);

/** Whether a repository-relative path is a test file in this suite's conventions. */
const isTestFile = (suite, file) => new RegExp(suite.testFiles).test(file);

const writeTree = (dir, files) => {
  for (const [file, content] of files) {
    const target = path.join(dir, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
};

/** A grader command with "{files}" replaced by the given paths. */
const graderCommand = (command, files = []) => command.flatMap((part) => (part === "{files}" ? files : [part]));

/** Runs a command in a throwaway container, without network unless one is named, in `dir` mounted at /w. */
const runContainer = async (image, dir, command, { env = {}, mounts = [], network = "none" } = {}) => {
  const args = ["run", "--rm", "--network", network, "--cpus", "2", "--memory", "1g", "--pids-limit", "256"];
  for (const [name, value] of Object.entries(env)) args.push("-e", `${name}=${value}`);
  for (const [source, target, mode = "rw"] of [[dir, "/w"], ...mounts]) args.push("-v", `${source}:${target}:${mode}`);
  args.push("-w", "/w", image, ...command);
  try {
    const result = await execFileAsync("docker", args, { timeout: 300_000, maxBuffer: 5_000_000 });
    return { passed: true, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    return { passed: false, output: `${error.stdout ?? ""}\n${error.stderr ?? error.message}` };
  }
};

/** Runs one of the suite's grader commands; a suite's build cache is kept in a named volume. */
const runGrader = (suite, dir, command, network) =>
  runContainer(suite.grader.image, dir, command, {
    env: suite.grader.env,
    mounts: suite.grader.cache ? [[`coding-eval-cache-${suite.name}`, suite.grader.cache]] : [],
    network,
  });

/**
 * Grades a set of files the way a reviewer would: optionally apply a diff,
 * run the project's own tests, then add the hidden files and run them. The
 * code under test runs only inside containers without network, beside the
 * suite's `grader.services` (started the way a run starts them). Only
 * `grader.setup` (installing dependencies into the cache) has network.
 */
const grade = async (suite, files, hiddenFiles, diff = "") => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-eval-"));
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-eval-patch-"));
  const servicesId = `coding-eval-${crypto.randomBytes(6).toString("hex")}`;
  try {
    writeTree(workDir, files);
    if (diff.trim()) {
      fs.writeFileSync(path.join(patchDir, "changes.diff"), diff);
      const applied = await runContainer(PATCH_IMAGE, workDir, ["git", "apply", "--whitespace=nowarn", "/patch/changes.diff"], {
        mounts: [[patchDir, "/patch", "ro"]],
      });
      if (!applied.passed) return { applied: false, visiblePassed: false, hiddenPassed: false, output: applied.output };
    }
    if (suite.grader.setup) {
      const setup = await runGrader(suite, workDir, suite.grader.setup, "bridge");
      if (!setup.passed) throw new Error(`${suite.name}: grader setup failed:\n${setup.output.slice(-2000)}`);
    }
    const network = suite.grader.services
      ? await startServices(servicesId, { image: suite.grader.image, services: suite.grader.services })
      : undefined;
    const visible = await runGrader(suite, workDir, suite.grader.test, network);
    // The hidden files are added only after the project's own tests ran.
    writeTree(workDir, hiddenFiles);
    const hidden = hiddenFiles.size
      ? await runGrader(suite, workDir, graderCommand(suite.grader.hiddenTest, [...hiddenFiles.keys()]), network)
      : { passed: true, output: "" };
    return {
      applied: true,
      visiblePassed: visible.passed,
      hiddenPassed: hidden.passed,
      visibleOutput: visible.output,
      hiddenOutput: hidden.output,
      output: [visible.passed ? "" : visible.output, hidden.passed ? "" : hidden.output].join("\n").trim(),
    };
  } finally {
    if (suite.grader.services) await removeServices(servicesId);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(patchDir, { recursive: true, force: true });
  }
};

/**
 * Files touched and lines added/removed by a `git diff` patch. `editedFiles`
 * lists files that lost or changed at least one existing line (including
 * deleted files), as opposed to files that only gained lines.
 */
const diffStats = (diff) => {
  const files = new Set();
  const editedFiles = new Set();
  let current;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      files.add(current);
    } else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
      editedFiles.add(current);
    }
  }
  return { files: [...files].sort(), editedFiles: [...editedFiles].sort(), added, removed };
};

module.exports = {
  cleanFiles,
  diffStats,
  grade,
  graderCommand,
  isTestFile,
  loadScenarios,
  loadSuites,
  scenarioFiles,
  writeTree,
};
