import { ChildProcess, execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { findSymlink } from "../utils/safePath";
import type { SandboxLimits } from "./agentGraph/repoPolicy";
import { DevcontainerBuild, SANDBOX_ROOT, ServiceContainer, Toolchain, commandText } from "./toolchain";

const exec = promisify(execFile);
const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Unsafe workspace id");
  }
  return id;
};
export const workspacePath = (id: string) =>
  path.resolve(config.workspaceRoot, safeId(id));

export const createWorkspace = async (id: string) => {
  const root = workspacePath(id);
  await fs.mkdir(root, { recursive: true });
  return root;
};
export const removeWorkspace = async (id: string) => {
  const root = workspacePath(id);
  await removeEnvironmentSnapshot(id);
  await removeServices(id);
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    // On Linux the container writes as root, so the host user may not be
    // able to delete those files; delete them from inside a container.
    await execDocker(
      dockerArgs(root, false, false, [
        "find",
        "/workspace",
        "-mindepth",
        "1",
        "-delete",
      ]),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
};
// Repository-controlled config (hooks, fsmonitor, textconv) must never run
// with credentials or influence what is reviewed. fileMode=false because
// files are written from the host: on Windows bind mounts every file looks
// executable, which would put a spurious mode change in each diff.
const SAFE_GIT =
  "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.fileMode=false";
const SAFE_GIT_ARGS = [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.fileMode=false",
];
// The token is read from the container env and sent as an HTTP header, so it
// is never written to .git/config or placed on the docker command line. Only
// to github.com, and only over HTTPS: a submodule on another host never gets
// it, and no submodule can use file://, ssh or ext:: transports.
const AUTH_GIT = `${SAFE_GIT} -c protocol.allow=never -c protocol.https.allow=always -c http.https://github.com/.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"`;

// Clone, diff, reset and cleanup only: any image with git and a shell. The
// repository's own commands run in its toolchain's image instead.
const GIT_IMAGE = "node:20-bookworm";
/** Docker's resource flags for a container: the repository's limits, else the defaults. */
export const limitArgs = (limits?: SandboxLimits | null) => [
  "--cpus",
  String(limits?.sandboxCpus ?? 2),
  "--memory",
  `${limits?.sandboxMemoryMb ?? 2048}m`,
  "--pids-limit",
  String(limits?.sandboxMaxProcesses ?? 256),
];
const SETUP_TIMEOUT_MS = 900_000;

const envArgs = (env: Record<string, string> = {}) =>
  Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

// On a Linux host the workspace belongs to the host user, not the container's,
// and git refuses it ("dubious ownership"). We cloned it ourselves, so trust it;
// env config also covers git run by the repository's own checks, in any image.
const TRUST_WORKSPACE = envArgs({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: SANDBOX_ROOT,
});

const dockerArgs = (
  root: string,
  network: boolean,
  withToken: boolean,
  command: string[],
  options: { image?: string; env?: Record<string, string>; services?: string; limits?: SandboxLimits | null } = {},
) => [
  "run",
  "--rm",
  ...limitArgs(options.limits),
  "--network",
  network ? "bridge" : (options.services ?? "none"),
  // `-e NAME` without a value makes docker read it from our process env.
  ...(withToken ? ["-e", "GITHUB_TOKEN"] : []),
  ...envArgs(options.env),
  ...TRUST_WORKSPACE,
  ...workspaceMounts(root, !options.image),
  "-w",
  SANDBOX_ROOT,
  options.image ?? GIT_IMAGE,
  ...command,
];

/**
 * The repository's own commands (checks, the agent's commands) see .git
 * read-only: through it they could hide changes from the diff that is
 * reviewed and published (assume-unchanged, exclude entries, commits).
 * Only our git operations, in the git image, may write it.
 */
const workspaceMounts = (root: string, writableGit: boolean) => [
  "-v",
  `${root}:${SANDBOX_ROOT}`,
  ...(writableGit || !existsSync(path.join(root, ".git"))
    ? []
    : ["-v", `${path.join(root, ".git")}:${SANDBOX_ROOT}/.git:ro`]),
];

/**
 * execFile's error message is the command line plus stderr only; failures
 * need the exit status and stdout too (npm prints test failures there).
 */
const dockerFailure = (error: unknown, secrets: string[] = []) => {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
  };
  const tail = (text = "") =>
    secrets.filter(Boolean).reduce((masked, secret) => masked.split(secret).join("***"), text).trim().slice(-4000) ||
    "(empty)";
  const status = failure.killed
    ? `killed by ${failure.signal ?? "timeout"}`
    : `exit code ${failure.code ?? "unknown"}`;
  return new Error(
    `docker run failed (${status})\nstderr:\n${tail(failure.stderr)}\nstdout:\n${tail(failure.stdout)}`,
  );
};

/**
 * What a long step (a devcontainer build, setup, a check before or after the
 * change) reports while it runs, so a person can see a run is alive and what
 * it is doing. `output` is the end of what it printed so far, secrets masked.
 */
export interface StepProgress {
  step: "build" | "setup" | "baseline" | "check";
  check?: string;
  command: string;
  elapsedSeconds: number;
  silentSeconds: number;
  possiblyHung: boolean;
  output: string;
}
export type ProgressReporter = (progress: StepProgress) => Promise<void>;
interface Progress {
  report: ProgressReporter;
  step: StepProgress["step"];
  check?: string;
  command: string[];
}

const PROGRESS_OUTPUT = 2000;
// Kept longer than what is reported, so a secret (at most 4000 characters)
// cut at the start of the buffer falls outside what is reported once masked.
const PROGRESS_BUFFER = PROGRESS_OUTPUT + 8000;
const mask = (text: string, secrets: string[]) =>
  secrets.filter(Boolean).reduce((masked, secret) => masked.split(secret).join("***"), text);

/**
 * Awaits a command, reporting its progress every EXECUTION_PROGRESS_INTERVAL_SECONDS.
 * Reports are written one at a time, and the last one before this returns:
 * events are numbered in order, so a report still being written would clash
 * with the step's next event.
 */
export const withProgress = async <T>(
  running: Promise<T> & { child?: ChildProcess },
  progress: Progress | undefined,
  secrets: string[] = [],
): Promise<T> => {
  const interval = config.executionProgressIntervalSeconds * 1000;
  if (!progress || !interval) return running;
  const started = Date.now();
  let lastOutput = started;
  let output = "";
  const take = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-PROGRESS_BUFFER);
    lastOutput = Date.now();
  };
  running.child?.stdout?.on("data", take);
  running.child?.stderr?.on("data", take);
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    const now = Date.now();
    const silentSeconds = Math.round((now - lastOutput) / 1000);
    const report: StepProgress = {
      step: progress.step,
      ...(progress.check ? { check: progress.check } : {}),
      command: commandText(progress.command),
      elapsedSeconds: Math.round((now - started) / 1000),
      silentSeconds,
      possiblyHung: config.executionHungAfterSeconds > 0 && silentSeconds >= config.executionHungAfterSeconds,
      output: mask(output, secrets).slice(-PROGRESS_OUTPUT),
    };
    // A lost report must never fail the step it describes.
    pending = pending.then(() => progress.report(report)).catch(() => undefined);
  }, interval);
  timer.unref();
  try {
    return await running;
  } finally {
    clearInterval(timer);
    await pending;
  }
};

/** `secrets` are passed by name (`-e NAME` in args) through our env, and masked in failures. */
const execDocker = async (args: string[], secrets: Record<string, string> = {}, timeout = 300_000, progress?: Progress) => {
  try {
    return await withProgress(
      exec("docker", args, {
        timeout,
        maxBuffer: 5_000_000,
        env: { ...process.env, ...secrets },
      }),
      progress,
      Object.values(secrets),
    );
  } catch (error) {
    throw dockerFailure(error, Object.values(secrets));
  }
};

export const runDocker = async (
  id: string,
  command: string[],
  network = false,
) => {
  // Git commands here walk everything setup installed (e.g. a Rust target/
  // tree), so they get setup's bound, not the 5-minute default (found on fd).
  const result = await execDocker(
    dockerArgs(workspacePath(id), network, false, command),
    {},
    SETUP_TIMEOUT_MS,
  );
  return { stdout: result.stdout, stderr: result.stderr };
};

const assertSafeRepo = (...values: string[]) => {
  if (!values.every((value) => /^[a-zA-Z0-9_.-]+$/.test(value)))
    throw new Error("Unsafe repository identifier");
};

export const cloneGithubWorkspace = async (
  id: string,
  owner: string,
  repo: string,
  sha: string,
  token: string,
) => {
  assertSafeRepo(owner, repo, sha);
  // Start from an empty directory so a partial earlier clone cannot wedge retries.
  await removeWorkspace(id);
  const root = await createWorkspace(id);
  // Submodules at the commit's recorded revisions; a no-op without .gitmodules.
  const script = `${AUTH_GIT} clone https://github.com/${owner}/${repo}.git . && ${SAFE_GIT} checkout ${sha} && ${AUTH_GIT} submodule update --init --recursive`;
  await execDocker(dockerArgs(root, true, true, ["sh", "-c", script]), { GITHUB_TOKEN: token });
};

/** Untracked files git doesn't ignore; `directories` collapses whole new folders. */
const untrackedFiles = async (
  id: string,
  directories = false,
  which: "visible" | "ignored" | "all" = "visible",
) =>
  (
    await runDocker(id, [
      ...SAFE_GIT_ARGS,
      "ls-files",
      "-z",
      "--others",
      ...(which === "all" ? [] : ["--exclude-standard"]),
      ...(which === "ignored" ? ["--ignored"] : []),
      ...(directories ? ["--directory"] : []),
    ])
  ).stdout
    .split("\0")
    .filter(Boolean);

const excludeFromDiffs = async (id: string, entries: string[]) => {
  if (entries.length)
    await fs.appendFile(
      path.join(workspacePath(id), ".git", "info", "exclude"),
      entries.map((entry) => `/${entry.replace(/([*?[\\!#])/g, "\\$1")}\n`).join(""),
    );
};

/**
 * Runs `work` (a check) and keeps whatever it creates out of diffs and
 * resets: build output and caches a check writes (__pycache__, target/,
 * coverage) are never part of the change, whatever the language.
 */
export const keepOutputOutOfDiffs = async <T>(id: string, work: () => Promise<T>) => {
  const before = new Set(await untrackedFiles(id));
  try {
    return await work();
  } finally {
    await excludeFromDiffs(
      id,
      (await untrackedFiles(id)).filter((file) => !before.has(file)),
    );
  }
};

const setupContainer = (id: string) => `agent-setup-${safeId(id).toLowerCase()}`;
const snapshotImage = (id: string) => `agent-env-${safeId(id).toLowerCase()}`;

/** Deletes an execution's environment snapshot, if it has one. */
export const removeEnvironmentSnapshot = async (id: string) => {
  for (const args of [["rm", "-f", setupContainer(id)], ["rmi", "-f", snapshotImage(id)]])
    await exec("docker", args).catch(() => undefined);
};

/** Starting the image or running the setup command failed; the message is its output. */
export class SetupFailedError extends Error {
  name = "SetupFailedError";
}

/**
 * Builds the project's devcontainer (its Dockerfile or Compose service, and
 * its features) with the Dev Container CLI, the spec's reference
 * implementation, and returns the image. Network for base images, features
 * and packages, never the token. The CLI's `build` does not run
 * `initializeCommand` (the one command meant for the host), and is given
 * no lockfile so it writes nothing into the clone. Docker's layer cache keeps
 * an unchanged build quick. shortcut: BuildKit takes no --cpus/--memory, so a
 * build is limited only by its timeout; limit the builder once servers run it.
 */
export const buildEnvironmentImage = async (
  id: string,
  scope: string,
  build: DevcontainerBuild,
  timeoutMs = SETUP_TIMEOUT_MS,
  report?: ProgressReporter,
) => {
  const root = workspacePath(id);
  // A link could make the build read a host file or folder.
  for (const input of build.inputs)
    if (findSymlink(root, input)) throw new SetupFailedError(`${input} is a symlink, so the devcontainer was not built`);
  const built = `agent-build-tmp-${safeId(id).toLowerCase()}`;
  try {
    await withProgress(
      exec(
        process.execPath,
        [
          DEVCONTAINER_CLI, "build", "--workspace-folder", root, "--config", path.join(root, build.config),
          "--image-name", built, "--no-lockfile", "--oci-auth-hardening", "--log-format", "text",
        ],
        { timeout: timeoutMs, maxBuffer: 20_000_000, env: buildEnvironment() },
      ),
      report && { report, step: "build", command: ["devcontainer", "build", build.config] },
    );
  } catch (error) {
    throw new SetupFailedError(`building ${build.config} failed: ${dockerFailure(error).message}`);
  }
  try {
    // Identical rebuilds get new IDs, so the tag is the image's content: the
    // environment cache stays valid while that is unchanged.
    const { stdout } = await execDocker(["image", "inspect", "--format", "{{json .RootFS.Layers}}{{json .Config}}", built]);
    const image = `agent-build-${safeId(scope).toLowerCase()}:${crypto.createHash("sha256").update(stdout).digest("hex").slice(0, 32)}`;
    await execDocker(["tag", built, image]);
    return image;
  } finally {
    await exec("docker", ["rmi", built]).catch(() => undefined);
  }
};

const DEVCONTAINER_CLI = require.resolve("@devcontainers/cli/devcontainer.js");
// devcontainer.json's ${localEnv:NAME} and Compose's ${NAME} read the build's
// environment, so it gets only what Docker and the OS need, none of the app's secrets.
const BUILD_ENV = new Set(
  ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
   "PROGRAMDATA", "PROGRAMFILES", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"],
);
const buildEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => BUILD_ENV.has(name.toUpperCase()))),
  // Compose builds through Bake, which refuses the CLI's generated Dockerfile
  // (in the temp folder) unless file reads are allowed. readCompose refuses
  // every Compose path outside the repository instead.
  BUILDX_BAKE_ENTITLEMENTS_FS: "0",
});

/**
 * The toolchain's service containers (a database, a cache) for one run, on
 * an internal Docker network: the run's containers reach them by name, and
 * nothing on it reaches the internet. Started when a container that needs
 * them starts (setup, the sandbox, verification), so a resumed run gets them
 * back; removed with the workspace. Returns the network, or undefined when
 * the toolchain has no services.
 */
const servicesNetwork = (id: string) => `agent-net-${safeId(id).toLowerCase()}`;
const serviceContainer = (id: string, name: string) => `agent-svc-${safeId(id).toLowerCase()}-${name}`;
const SERVICES_LABEL = "agent.services";

export const startServices = async (id: string, toolchain: Toolchain, limits?: SandboxLimits | null) => {
  if (!toolchain.services?.length) return undefined;
  const network = servicesNetwork(id);
  const label = ["--label", `${SERVICES_LABEL}=${safeId(id)}`];
  const exists = await exec("docker", ["network", "inspect", network]).then(() => true, () => false);
  if (!exists) await execDocker(["network", "create", "--internal", ...label, network]);
  for (const service of toolchain.services) {
    const name = serviceContainer(id, service.name);
    const running = await exec("docker", ["inspect", "--format", "{{.State.Running}}", name]).then(
      (result) => result.stdout.trim() === "true",
      () => false,
    );
    if (running) continue;
    await exec("docker", ["rm", "-f", "-v", name]).catch(() => undefined);
    // The daemon pulls the image, so the internal network does not stop that.
    await execDocker(
      ["run", "-d", "--name", name, ...label, ...limitArgs(limits), "--network", network, "--network-alias", service.name, ...envArgs(service.env), service.image],
      {},
      SETUP_TIMEOUT_MS,
    );
    if (service.ready) await waitUntilReady(name, service);
  }
  return network;
};

const waitUntilReady = async (container: string, service: ServiceContainer) => {
  const seconds = service.readyTimeoutSeconds ?? 120;
  const deadline = Date.now() + seconds * 1000;
  for (;;)
    try {
      await exec("docker", ["exec", container, ...service.ready!], { timeout: 30_000 });
      return;
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`service "${service.name}" was not ready after ${seconds}s: ${dockerFailure(error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
};

export const removeServices = async (id: string) => {
  const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `label=${SERVICES_LABEL}=${safeId(id)}`]).catch(() => ({ stdout: "" }));
  const containers = stdout.split(/\s+/).filter(Boolean);
  // -v: database images declare volumes, which would otherwise pile up.
  if (containers.length) await exec("docker", ["rm", "-f", "-v", ...containers]).catch(() => undefined);
  await exec("docker", ["network", "rm", servicesNetwork(id)]).catch(() => undefined);
};

/** How a check did on the unmodified code, during setup. */
export interface BaselineResult {
  check: string;
  passed: boolean;
  output: string;
}

/**
 * Prepares the environment and returns the image every later command uses.
 * In one container with network (package registries) but never the GitHub
 * token, since this runs repository-controlled code:
 *
 * 1. the repository's setup command, if any;
 * 2. each check once, on the unmodified code. Tools fetch some things only
 *    when they really run (test-framework providers, plugins, modules), and
 *    the later checks have no network. The results are the baseline: how the
 *    code did before the agent changed anything.
 *
 * Tools install to different places (~/.m2, ~/.cache, /usr/local), so the
 * container is then snapshotted with `docker commit` instead of knowing any
 * of them; the workspace is a bind mount, so it is not in the snapshot.
 * What setup installed inside the workspace (node_modules, .venv, vendor)
 * is copied into the snapshot too, so verification can restore it exactly
 * (see prepareVerification). Whatever this created inside the workspace is
 * excluded from diffs.
 */
export const setupWorkspace = async (
  id: string,
  toolchain: Toolchain,
  checks: Array<{ name: string; command: string[] }>,
  options: { cacheFor?: string; setupTimeoutMs?: number; secrets?: Record<string, string>; progress?: ProgressReporter; limits?: SandboxLimits | null } = {},
) => {
  const baseline: BaselineResult[] = [];
  let setupOutputs: string[] = [];
  if (!toolchain.setup && !checks.length)
    return { image: toolchain.image, baseline, setupOutputs, cache: "none" as CacheUse };

  await removeEnvironmentSnapshot(id);
  const cache =
    options.cacheFor && config.executionSnapshotMaxAgeHours
      ? environmentCacheImage(options.cacheFor, toolchain, checks)
      : undefined;
  const reuse = cache !== undefined && (await isFreshImage(cache, config.executionSnapshotMaxAgeHours));
  const args = dockerArgs(workspacePath(id), true, false, ["sleep", "infinity"], {
    image: reuse ? cache : toolchain.image,
    env: toolchain.env,
    limits: options.limits,
  });
  // Same limits as every container, but long-lived so it can be committed.
  args.splice(args.indexOf("--rm"), 1, "-d", "--name", setupContainer(id));
  // Secrets go to the setup command only, as exec env, which `docker commit`
  // does not keep: the checks, the snapshot and the agent never have them.
  const run = (command: string[], secrets: Record<string, string> = {}, step?: Pick<Progress, "step" | "check">) =>
    execDocker(
      ["exec", ...Object.keys(secrets).flatMap((name) => ["-e", name]), setupContainer(id), ...command],
      secrets,
      options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
      step && options.progress && { ...step, report: options.progress, command },
    );
  try {
    try {
      const services = await startServices(id, toolchain, options.limits);
      await execDocker(args);
      // Setup keeps the bridge for package registries and joins the services' network too.
      if (services) await execDocker(["network", "connect", services, setupContainer(id)]);
      if (toolchain.setup) await run(toolchain.setup, options.secrets, { step: "setup" });
    } catch (error) {
      throw new SetupFailedError((error as Error).message);
    }
    if (toolchain.setup) {
      // A fresh clone has no untracked files: these all came from setup.
      setupOutputs = (await untrackedFiles(id, true, "all")).map((entry) => entry.replace(/\/$/, ""));
      // A reused snapshot holds an earlier run's copy; only this run's counts.
      await run(["rm", "-rf", SETUP_COPY_DIR]);
      if (setupOutputs.length)
        await run(["sh", "-c", COPY_ENTRIES, "sh", SANDBOX_ROOT, SETUP_COPY_DIR, ...setupOutputs]);
    }
    for (const { name, command } of checks)
      try {
        const result = await run(command, {}, { step: "baseline", check: name });
        baseline.push({ check: name, passed: true, output: `${result.stdout}\n${result.stderr}`.slice(-4000) });
      } catch (error) {
        baseline.push({ check: name, passed: false, output: (error as Error).message.slice(-4000) });
      }
    await execDocker([
      "commit",
      "--change",
      `LABEL ${CACHE_LABEL}=${cache ? cacheRepository(cache) : "none"}`,
      setupContainer(id),
      snapshotImage(id),
    ]);
  } finally {
    await exec("docker", ["rm", "-f", setupContainer(id)]).catch(() => undefined);
  }
  // Only a snapshot built from the plain image becomes the cache, so layers
  // never pile up across runs; a stale cache is rebuilt the same way.
  if (cache && !reuse) await storeEnvironmentCache(snapshotImage(id), cache);
  // A fresh clone has no untracked files, so everything here came from setup.
  await excludeFromDiffs(id, await untrackedFiles(id, true));
  return { image: snapshotImage(id), baseline, setupOutputs, cache: (cache ? (reuse ? "reused" : "built") : "none") as CacheUse };
};

/**
 * Environment snapshots are reused across runs of one repository, the way
 * Codex caches its containers: a run starts from the cached snapshot and
 * runs setup again with network, so dependency changes are still installed
 * but what is already there is not downloaded again. Nothing is chosen per
 * tool or language. The key is the environment (image, setup, env, checks),
 * so a changed or newly approved environment starts fresh. A snapshot holds
 * whatever the repository's setup ran, so it is never shared between
 * repositories.
 */
export type CacheUse = "none" | "built" | "reused";
const CACHE_LABEL = "agent.environment-cache";
const cacheRepository = (image: string) => image.split(":")[0];

export const environmentCacheImage = (
  scope: string,
  toolchain: Pick<Toolchain, "image" | "setup" | "env">,
  checks: Array<{ name: string; command: string[] }>,
) => {
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify([toolchain.image, toolchain.setup, Object.entries(toolchain.env).sort(), checks]))
    .digest("hex")
    .slice(0, 32);
  return `agent-cache-${safeId(scope).toLowerCase()}:${key}`;
};

/** Whether an image was created less than maxAgeHours ago (false if it doesn't exist). */
export const isFresh = (created: string, maxAgeHours: number, now = Date.now()) => {
  const time = Date.parse(created);
  return Number.isFinite(time) && now - time < maxAgeHours * 3_600_000;
};
const isFreshImage = async (image: string, maxAgeHours: number) => {
  try {
    const { stdout } = await exec("docker", ["image", "inspect", "--format", "{{.Created}}", image]);
    return isFresh(stdout.trim(), maxAgeHours);
  } catch {
    return false;
  }
};

/** Tags the snapshot as the repository's cache and drops its older caches that nothing uses. */
const storeEnvironmentCache = async (snapshot: string, cache: string) => {
  await execDocker(["tag", snapshot, cache]);
  const { stdout } = await exec("docker", ["images", cacheRepository(cache), "--format", "{{.Repository}}:{{.Tag}}"]);
  for (const old of stdout.split("\n").map((line) => line.trim()).filter((line) => line && line !== cache))
    await exec("docker", ["rmi", old]).catch(() => undefined);
  // Replaced caches still used by a running execution's snapshot stay until it ends.
  // Removed by ID: on Docker's containerd store `image prune`, whatever its filter,
  // breaks another execution's `docker commit` that is in progress ("No such image").
  const { stdout: dangling } = await exec("docker", [
    "images", "-q", "--filter", "dangling=true", "--filter", `label=${CACHE_LABEL}=${cacheRepository(cache)}`,
  ]).catch(() => ({ stdout: "" }));
  for (const image of new Set(dangling.split("\n").map((line) => line.trim()).filter(Boolean)))
    await exec("docker", ["rmi", image]).catch(() => undefined);
};

// Inside the snapshot, outside the workspace: what setup installed there.
const SETUP_COPY_DIR = "/opt/agent-setup-output";
// sh -c COPY_ENTRIES sh <from> <to> <entry>...: replaces each entry under <to>
// with a full copy of it from <from>, keeping modes and links.
const COPY_ENTRIES =
  'from=$1; to=$2; shift 2; for e in "$@"; do rm -rf "$to/$e" && mkdir -p "$(dirname "$to/$e")" && cp -a "$from/$e" "$to/$e" || exit 1; done';

/**
 * Makes the workspace hold only the change before the checks that judge it.
 * Anything the agent or a check left that the diff doesn't show (ignored or
 * excluded files: a conftest.py hidden from git, edited dependencies, build
 * output) is deleted, and what setup installed is restored from the copy in
 * the snapshot. So checks see exactly the base commit, the setup, and the
 * diff that is reviewed and published.
 */
export const prepareVerification = async (id: string, image: string, setupOutputs: string[]) => {
  const isSetupOutput = (entry: string) =>
    setupOutputs.some((output) => entry === output || entry.startsWith(`${output}/`));
  const leftovers = (await untrackedFiles(id, true, "ignored"))
    .map((entry) => entry.replace(/\/$/, ""))
    .filter((entry) => !isSetupOutput(entry));
  if (leftovers.length) await runDocker(id, ["rm", "-rf", "--", ...leftovers]);
  if (setupOutputs.length)
    await execDocker(
      dockerArgs(workspacePath(id), false, false, ["sh", "-c", COPY_ENTRIES, "sh", SETUP_COPY_DIR, SANDBOX_ROOT, ...setupOutputs], {
        image,
      }),
      {},
      SETUP_TIMEOUT_MS,
    );
};
/**
 * Commands that return a clone to its checked-out commit: tracked changes,
 * intent-to-add entries and new files are dropped. Ignored files (what
 * setup installed, tool caches) are kept so retries don't set up again.
 */
export const WORKSPACE_RESET_COMMANDS = [
  [...SAFE_GIT_ARGS, "reset", "--hard", "--quiet"],
  [...SAFE_GIT_ARGS, "clean", "-fd", "--quiet"],
];
export const resetWorkspace = async (id: string) => {
  for (const command of WORKSPACE_RESET_COMMANDS) await runDocker(id, command);
};
/**
 * Returns the workspace to a fresh clone: no changes, no untracked or ignored
 * files and no diff exclusions, so another environment can be set up in it.
 */
export const restoreClone = async (id: string) => {
  await removeEnvironmentSnapshot(id);
  await runDocker(id, [...SAFE_GIT_ARGS, "reset", "--hard", "--quiet"]);
  await runDocker(id, [...SAFE_GIT_ARGS, "clean", "-ffdx", "--quiet"]);
  await fs.writeFile(path.join(workspacePath(id), ".git", "info", "exclude"), "");
};
export const gitDiff = async (id: string) => {
  await runDocker(id, [...SAFE_GIT_ARGS, "add", "-N", "."]);
  return (
    await runDocker(id, [
      ...SAFE_GIT_ARGS,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ])
  ).stdout;
};
export const changedFiles = async (id: string) =>
  (await changes(id)).map((change) => change.file);

/** A changed file and how: A added, M modified, D deleted, T type changed. */
export interface FileChange {
  status: string;
  file: string;
}

/** The change as the diff shows it; renames appear as a deletion and an addition. */
export const changes = async (id: string): Promise<FileChange[]> => {
  await runDocker(id, [...SAFE_GIT_ARGS, "add", "-N", "."]);
  const fields = (
    await runDocker(id, [...SAFE_GIT_ARGS, "diff", "--name-status", "--no-renames", "-z", "--no-ext-diff"])
  ).stdout
    .split("\0")
    .filter(Boolean);
  const result: FileChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2)
    result.push({ status: fields[index], file: fields[index + 1] });
  return result;
};

/** Files in the checked-out commit, whatever the index or working tree hold now. */
export const trackedFiles = async (id: string) =>
  (await runDocker(id, [...SAFE_GIT_ARGS, "ls-tree", "-r", "-z", "--name-only", "HEAD"])).stdout
    .split("\0")
    .filter(Boolean);

/**
 * Publishes an approved diff from a fresh clone. The verification workspace
 * ran untrusted code, so nothing from it (hooks, config, untracked files)
 * is trusted; only the reviewed patch is applied and pushed.
 */
export const publishApprovedDiff = async (input: {
  executionId: string;
  diff: string;
  branch: string;
  baseSha: string;
  owner: string;
  repo: string;
  token: string;
}) => {
  assertSafeRepo(input.owner, input.repo, input.baseSha);
  if (!/^[a-zA-Z0-9_./-]+$/.test(input.branch))
    throw new Error("Unsafe Git identifier");
  const publishId = `${input.executionId}-publish`;
  await removeWorkspace(publishId);
  const root = await createWorkspace(publishId);
  await fs.writeFile(path.join(root, "changes.diff"), input.diff, "utf8");
  const script = [
    `mkdir repo && cd repo`,
    `${AUTH_GIT} clone https://github.com/${input.owner}/${input.repo}.git .`,
    `${SAFE_GIT} checkout ${input.baseSha}`,
    `${SAFE_GIT} checkout -b '${input.branch}'`,
    `${SAFE_GIT} apply --index --binary ../changes.diff`,
    `${SAFE_GIT} -c user.name='Agent Orchestrator' -c user.email='agent@localhost' commit --no-verify -m 'fix: automated bug fix'`,
    // Force is safe: the branch is owned by this execution, and a retry after
    // a partial publish must be able to replace its own earlier push.
    `${AUTH_GIT} push --no-verify --force origin 'HEAD:refs/heads/${input.branch}'`,
  ].join(" && ");
  try {
    await execDocker(
      dockerArgs(root, true, true, ["sh", "-c", script]),
      { GITHUB_TOKEN: input.token },
    );
  } finally {
    await removeWorkspace(publishId);
  }
};
export interface CheckResult {
  script: string;
  passed: boolean;
  output: string;
  /** Configured, but the toolchain has no command for it. */
  unavailable?: true;
  /** Failed on the unmodified code too, so its failure does not block the change. */
  failingBefore?: true;
}

/**
 * Runs the toolchain's checks in its image, without internet (only its services), stopping at
 * the first failure. A check in `failingBefore` failed on the unmodified
 * code, so failing again doesn't block: established agents report a test
 * that was already broken instead of refusing the change, and a person
 * decides. It is recorded, and the next check still runs. A configured check that doesn't exist is recorded as
 * unavailable and does not fail the verification: it says nothing about
 * the change.
 */
export const verifyWorkspace = async (
  id: string,
  toolchain: Toolchain,
  checks: { run: Array<{ name: string; command: string[] }>; unavailable: string[] },
  failingBefore: string[] = [],
  report?: ProgressReporter,
  limits?: SandboxLimits | null,
) => {
  const results: CheckResult[] = checks.unavailable.map((script) => ({
    script,
    passed: true,
    unavailable: true,
    output: `No "${script}" check is configured for this repository.`,
  }));
  let failed = false;
  const services = checks.run.length ? await startServices(id, toolchain, limits) : undefined;
  for (const { name, command } of checks.run)
    try {
      const result = await keepOutputOutOfDiffs(id, () =>
        execDocker(
          dockerArgs(workspacePath(id), false, false, command, {
            image: toolchain.image,
            env: toolchain.env,
            services,
            limits,
          }),
          {},
          limits?.checkTimeoutSeconds ? limits.checkTimeoutSeconds * 1000 : undefined,
          report && { report, step: "check", check: name, command },
        ),
      );
      results.push({
        script: name,
        passed: true,
        output: `${result.stdout}\n${result.stderr}`.slice(-100_000),
      });
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      if (failingBefore.includes(name)) {
        results.push({ script: name, passed: false, failingBefore: true, output });
        continue;
      }
      results.push({ script: name, passed: false, output });
      failed = true;
      break;
    }
  return { passed: !failed, checksRun: checks.run.length, results };
};
/** The reviewer's unresolved objections to a change, for whoever decides on it; "" when there are none. */
export const describeReviewObjections = (verification: unknown) => {
  const { reviewObjections } = (verification ?? {}) as { reviewObjections?: string[] };
  if (!reviewObjections?.length) return "";
  return [
    "**The reviewer objected to this change.** The checks pass, but the reviewer still objected after the last attempt. Check these points before approving:",
    ...reviewObjections.map((objection) => `- ${objection.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
};

/** Checks that failed before the change and still fail, for whoever decides on it; "" when there are none. */
export const describeFailingBefore = (verification: unknown) => {
  const { results } = (verification ?? {}) as { results?: CheckResult[] };
  const names = (results ?? []).filter((result) => result.failingBefore).map((result) => result.script);
  if (!names.length) return "";
  return `**Already failing before this change:** ${names.join(", ")}. ${names.length > 1 ? "They" : "It"} failed on the unmodified code too, so ${names.length > 1 ? "they" : "it"} could not show whether this change breaks something ${names.length > 1 ? "they cover" : "it covers"}. Check the output before approving.`;
};

/** What a verification proved, for the PR body: which checks passed, which already failed, and which did not exist. */
export const describeVerification = (verification: unknown) => {
  const { checksRun, results } = (verification ?? {}) as {
    checksRun?: number;
    results?: CheckResult[];
  };
  const ran = (results ?? []).filter((result) => !result.unavailable).map((result) => result.script);
  const passed = (results ?? []).filter((result) => !result.unavailable && !result.failingBefore).map((result) => result.script);
  const unavailable = (results ?? []).filter((result) => result.unavailable).map((result) => result.script);
  const objections = describeReviewObjections(verification);
  const failing = describeFailingBefore(verification);
  // Artifacts from before toolchains have results but no checksRun.
  const lines = [
    ...(objections ? [objections, ""] : []),
    !(checksRun ?? ran.length)
      ? "**Unverified:** no checks are available for this repository, so nothing was run against this change."
      : passed.length
        ? `Checks passed: ${passed.join(", ")}.`
        : "No check passed.",
    ...(failing ? [failing] : []),
  ];
  if (unavailable.length) lines.push(`Not available in this repository: ${unavailable.join(", ")}.`);
  const { environmentProposal: proposal } = (verification ?? {}) as {
    environmentProposal?: { repositoryId: string; hash: string; checks: Record<string, string[]> };
  };
  if (proposal)
    lines.push(
      "",
      "**These checks were proposed by the agent from the project's files and are not approved yet:**",
      ...Object.entries(proposal.checks).map(([name, command]) => `- ${name}: \`${commandText(command)}\``),
      `Approve them once and every later run uses them as fixed checks: \`POST /api/repositories/${proposal.repositoryId}/environment/approve\` with \`{ "proposalHash": "${proposal.hash}" }\`.`,
    );
  return lines.join("\n");
};

/**
 * Long-lived sandbox for one run: started once, then each command is a
 * `docker exec`, instead of a new container per command. Same limits as
 * every other workspace container; no internet, only the run's services.
 */
const sandboxName = (id: string) => `agent-sandbox-${safeId(id)}`;

export const startSandbox = async (id: string, toolchain: Toolchain, limits?: SandboxLimits | null) => {
  // A crashed earlier attempt may have left one behind.
  await stopSandbox(id);
  const services = await startServices(id, toolchain, limits);
  await execDocker([
    "run",
    "-d",
    "--name",
    sandboxName(id),
    ...limitArgs(limits),
    "--network",
    services ?? "none",
    // `docker exec` inherits these, so every command sees the toolchain's caches.
    ...envArgs(toolchain.env),
    ...TRUST_WORKSPACE,
    ...workspaceMounts(workspacePath(id), false),
    "-w",
    SANDBOX_ROOT,
    toolchain.image,
    "sleep",
    "infinity",
  ]);
};

export const stopSandbox = async (id: string) => {
  try {
    await exec("docker", ["rm", "-f", sandboxName(id)], { timeout: 60_000 });
  } catch {
    // Not running: nothing to stop.
  }
};

export interface SandboxResult {
  exitCode: number;
  timedOut: boolean;
  output: string;
}

/**
 * Runs a command in the run's sandbox. A non-zero exit is a result, not an
 * error (a failing test is information for the agent). The time limit is
 * enforced inside the container, so a runaway process is killed there
 * instead of only detaching the host-side client.
 */
export const execInSandbox = async (
  id: string,
  command: string[],
  timeoutMs: number,
): Promise<SandboxResult> => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    const result = await exec(
      "docker",
      ["exec", sandboxName(id), "timeout", "-s", "KILL", String(seconds), ...command],
      { timeout: timeoutMs + 30_000, maxBuffer: 5_000_000 },
    );
    return { exitCode: 0, timedOut: false, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    // Docker itself failed (no daemon, container gone): not the command's result.
    if (
      typeof failure.code !== "number" ||
      /Error response from daemon|Cannot connect to the Docker daemon/.test(failure.stderr ?? "")
    )
      throw dockerFailure(error);
    return {
      exitCode: failure.code,
      // `timeout -s KILL` exits 137 when it had to kill the command.
      timedOut: failure.code === 137 || failure.killed === true,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    };
  }
};
