import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../../config";
import { NonRetryableError } from "../../utils/safeError";
import { readDevcontainer } from "./devcontainer";
import {
  Toolchain,
  ToolchainResolution,
  ToolchainSource,
  VerificationConfig,
} from "./types";

export * from "./types";

/** Reads a file of the cloned repository on the host; detection never runs repository code. */
export type ReadRepoFile = (file: string) => string | undefined;

export const fsRepoFiles =
  (root: string): ReadRepoFile =>
  (file) => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };

/**
 * Used when nothing is configured. Test-file patterns are naming
 * conventions shared across ecosystems (tests/ directories, *.test.*,
 * *_test.*, test_*, *Test.*); a repository can replace them.
 */
export const DEFAULT_TEST_FILE_PATTERNS = [
  "(^|/)(__tests__|tests?|specs?)/",
  "[._-](test|spec)s?\\.[A-Za-z0-9]+$",
  "(^|/)test_[^/]*$",
  "[a-z0-9](Test|Tests|Spec|IT)\\.[A-Za-z0-9]+$",
];
export const DEFAULT_PROTECTED_PATHS = [".github", ".gitlab-ci.yml", ".devcontainer", ".devcontainer.json"];

const isRegExp = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const command = z.array(z.string().min(1).max(1000)).min(1).max(100);
// Docker image reference: registry/name:tag or @digest. Never starts with "-",
// so it cannot be read as a docker option.
const IMAGE_PATTERN = /^[a-z0-9]+([._/:@-][a-zA-Z0-9]+)*$/;
const image = z.string().regex(IMAGE_PATTERN, "invalid image reference").max(255);
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(1000));
const service = z
  .object({
    // Part of a container name and a hostname.
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "lowercase letters, digits and dashes"),
    image,
    env: env.optional(),
    ready: command.optional(),
    readyTimeoutSeconds: z.number().int().min(1).max(600).optional(),
  })
  .strict();

/** Validates a repository's configuration; used by the API and again when a run starts. */
export const verificationConfigSchema = z
  .object({
    scripts: z.array(z.string().regex(/^[a-zA-Z0-9:_-]+$/)).min(1).optional(),
    toolchain: z
      .object({
        language: z.string().min(1).max(100).optional(),
        image: image.optional(),
        setup: command.nullable().optional(),
        checks: z.record(z.string().regex(/^[a-zA-Z0-9:_-]+$/), command).optional(),
        env: env.optional(),
        testFilePatterns: z.array(z.string().min(1).max(200).refine(isRegExp, "invalid regular expression")).optional(),
        protectedPaths: z.array(z.string().min(1).max(500)).optional(),
        services: z
          .array(service)
          .max(5)
          .refine((services) => new Set(services.map((s) => s.name)).size === services.length, "service names must be unique")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const parseVerificationConfig = (raw: unknown): VerificationConfig => {
  const parsed = verificationConfigSchema.safeParse(raw ?? {});
  if (!parsed.success)
    throw new NonRetryableError(
      `Repository verificationConfig is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
};

/** Stands for the image a devcontainer build produces, until the run builds it (`buildEnvironmentImage`). */
export const UNBUILT_IMAGE = "agent-build:unbuilt";

/**
 * The repository's environment, from (in order) its configuration, the
 * project's devcontainer, then the stock default image. Configured fields
 * win field by field; env is merged. Nothing is chosen per language.
 */
export const resolveToolchain = (read: ReadRepoFile, rawConfig: unknown): ToolchainResolution => {
  const configured = parseVerificationConfig(rawConfig).toolchain ?? {};
  const devcontainer = readDevcontainer(read);
  const notes = [...(devcontainer?.notes ?? [])];

  let source: ToolchainSource;
  let reason: string;
  if (configured.image) {
    source = "configured";
    reason = "image set in the repository configuration";
  } else if (devcontainer?.image && !IMAGE_PATTERN.test(devcontainer.image)) {
    notes.push(`${devcontainer.file} image "${devcontainer.image}" is not a valid image reference`);
    source = "default";
    reason = `${devcontainer.file} names no usable image; using the default image`;
  } else if (devcontainer?.build) {
    source = "devcontainer";
    reason = `image built from the project's ${devcontainer.file}`;
  } else if (devcontainer?.image) {
    source = "devcontainer";
    reason = `image from the project's ${devcontainer.file}`;
  } else {
    source = "default";
    reason = devcontainer
      ? `${devcontainer.file} names no usable image; using the default image`
      : "the project defines no environment; using the default image";
  }

  const fromProject = source !== "configured" && devcontainer;
  const build = source === "devcontainer" ? devcontainer!.build : undefined;
  // Compose services are checked like configured ones; configured services replace them.
  const projectServices = (fromProject ? devcontainer.services ?? [] : []).filter((candidate) => {
    const valid = service.safeParse(candidate).success;
    if (!valid) notes.push(`Compose service ${candidate.name} (${candidate.image}) was not started: invalid name or image`);
    return valid;
  });
  const services = configured.services?.length ? configured.services : projectServices.slice(0, 5);
  if (!configured.services?.length && projectServices.length > 5) notes.push("only the first 5 Compose services were started");
  const toolchain: Toolchain = {
    ...(configured.language ? { language: configured.language } : {}),
    image:
      configured.image ??
      (build ? UNBUILT_IMAGE : source === "devcontainer" ? devcontainer!.image! : config.executionDefaultImage),
    ...(build ? { build } : {}),
    setup: configured.setup !== undefined ? configured.setup : fromProject ? devcontainer.setup : null,
    checks: configured.checks ?? {},
    env: { ...(devcontainer?.env ?? {}), ...(configured.env ?? {}) },
    testFilePatterns: configured.testFilePatterns ?? DEFAULT_TEST_FILE_PATTERNS,
    protectedPaths: configured.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    ...(services.length ? { services } : {}),
  };
  if (!Object.keys(toolchain.checks).length)
    notes.push("no checks are configured for this repository, so changes cannot be verified");
  return { toolchain, source, reason, notes };
};

/**
 * The checks a verification runs. `scripts` (configured names) selects
 * checks; a configured name the toolchain doesn't have is reported as
 * unavailable rather than failed, since a missing check says nothing about
 * the change.
 */
export const selectChecks = (toolchain: Toolchain, rawConfig: unknown) => {
  const { scripts } = parseVerificationConfig(rawConfig);
  const names = scripts ?? Object.keys(toolchain.checks);
  return {
    run: names.filter((name) => toolchain.checks[name]).map((name) => ({ name, command: toolchain.checks[name] })),
    unavailable: names.filter((name) => !toolchain.checks[name]),
  };
};

/**
 * What will check a change, for the person approving its plan: the selected
 * checks, discovery during the run (it runs only when the toolchain has no
 * checks), or nothing at all.
 */
export type PlanVerification = "checks" | "discovery" | "none";
export const planVerification = (toolchain: Toolchain, rawConfig: unknown, discoveryAttempts: number): PlanVerification =>
  selectChecks(toolchain, rawConfig).run.length
    ? "checks"
    : !Object.keys(toolchain.checks).length && discoveryAttempts > 0
      ? "discovery"
      : "none";

/** A command as a person would type it: `sh -c "<script>"` shows as the script. */
export const commandText = (command: string[]) =>
  command.length === 3 && command[0] === "sh" && command[1] === "-c" ? command[2] : command.join(" ");

/** True for a file the toolchain treats as a test (repository-relative, "/" separators). */
export const isTestFile = (toolchain: Toolchain, file: string) =>
  toolchain.testFilePatterns.some((pattern) => new RegExp(pattern).test(file));

/** How many test files the repository has, and which of the given files no test names. */
export interface TestCoverage {
  testFiles: number;
  untested: string[];
}

/**
 * A rough, language-neutral sign of what the checks exercise: a test "names"
 * a file when its path or contents contain the file's base name (Go's
 * `bar_test.go`, Python's `import bar`, Java's `BarTest`). It is not real
 * coverage; it tells the approver when a passing check says little.
 */
export const testCoverage = (toolchain: Toolchain, repoFiles: string[], read: ReadRepoFile, files: string[]): TestCoverage => {
  const tests = repoFiles.filter((file) => isTestFile(toolchain, file));
  const texts = tests.map((file) => `${file}\n${read(file) ?? ""}`);
  const untested = files.filter((file) => {
    if (isTestFile(toolchain, file)) return false;
    const stem = path.posix.basename(file).replace(/\.[^.]*$/, "");
    return !texts.some((text) => text.includes(stem));
  });
  return { testFiles: tests.length, untested };
};

/** The coverage note for whoever approves the plan or the change; "" when there is nothing to warn about. */
export const describeTestCoverage = (coverage: TestCoverage | undefined) =>
  !coverage
    ? ""
    : !coverage.testFiles
      ? "**No tests:** this repository has no test files, so the checks passing will not show the change works; you will have to check it yourself."
      : coverage.untested.length
        ? `**No test names ${coverage.untested.length > 1 ? "these files" : "this file"}:** ${coverage.untested.join(", ")}. The checks may not run that code, so passing them says little about it.`
        : "";

/** What the agent is told about the environment: where commands run and what checks the change. */
export const describeEnvironment = (
  toolchain: Toolchain,
  checks: Array<{ name: string; command: string[] }>,
  canRunCommands: boolean,
  failingBefore: string[] = [],
) =>
  [
    ...(toolchain.language ? [`Language: ${toolchain.language}`] : []),
    `Image: ${toolchain.build ? `built from the project's ${toolchain.build.config}` : toolchain.image}`,
    ...(toolchain.services?.length
      ? [
          `Services, reachable by name from setup, checks and commands: ${toolchain.services.map((s) => `${s.name} (${s.image})`).join(", ")}`,
        ]
      : []),
    checks.length
      ? `Checks:\n${checks.map((check) => `- ${check.name}: ${commandText(check.command)}`).join("\n")}`
      : `Checks: none are configured for this repository.${
          canRunCommands
            ? " Find out how it is built and tested from its own files (README, build files, CI configuration) and use run_command to do that."
            : ""
        }`,
    ...(failingBefore.length
      ? [
          `Already failing before your change, on the unmodified code: ${failingBefore.join(", ")}. A failure there is not caused by you; compare with how it failed before, and fix only what the ticket asks.`,
        ]
      : []),
  ].join("\n");

/** A one-line description for prompts and events. */
export const describeToolchain = (toolchain: Toolchain) => {
  const checks = Object.keys(toolchain.checks);
  const services = toolchain.services?.map((s) => s.name) ?? [];
  return `${toolchain.language ? `${toolchain.language}; ` : ""}image ${toolchain.image}; checks: ${checks.length ? checks.join(", ") : "none available"}${services.length ? `; services: ${services.join(", ")}` : ""}`;
};
