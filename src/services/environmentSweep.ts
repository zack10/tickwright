import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { ExecutionStatus } from "@prisma/client";
import { config } from "../config";
import prisma from "../db";
import { NonRetryableError, describeError } from "../utils/safeError";
import { isFresh, removeWorkspace, withImageLock } from "./workspaceService";

/**
 * Removes what runs leave behind when their own cleanup was missed (the app
 * or Docker stopped mid-run): an ended execution's snapshot, containers,
 * network and clone, and a repository's environment cache and devcontainer
 * build once they are older than EXECUTION_SNAPSHOT_MAX_AGE_HOURS. Only what
 * this app's database knows is touched: another instance on the same Docker
 * (a local server beside the production stack) has ids this one has never
 * seen, so its resources stay.
 */

const exec = promisify(execFile);
const ENDED: ExecutionStatus[] = ["COMPLETED", "BLOCKED", "FAILED", "CANCELED"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** Which of these ids this database has, and in which state. */
export interface SweepLookups {
  endedExecutions: (ids: string[]) => Promise<string[]>;
  /** Repositories with no execution in progress. */
  idleRepositories: (ids: string[]) => Promise<string[]>;
}

const prismaLookups: SweepLookups = {
  endedExecutions: async (ids) =>
    (await prisma.execution.findMany({ where: { id: { in: ids }, status: { in: ENDED } }, select: { id: true } })).map(
      (execution) => execution.id,
    ),
  idleRepositories: async (ids) =>
    (
      await prisma.repository.findMany({
        where: { id: { in: ids }, executions: { none: { status: { notIn: ENDED } } } },
        select: { id: true },
      })
    ).map((repository) => repository.id),
};

const dockerLines = async (args: string[]) => {
  try {
    const { stdout } = await exec("docker", args, { timeout: 60_000 });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
};
const idOf = (name: string) => name.match(UUID)?.[0].toLowerCase();
const ids = (names: string[]) => [...new Set(names.map(idOf).filter((id): id is string => !!id))];

export interface SweepResult {
  executions: string[];
  images: string[];
}

export const sweepEnvironments = async (lookups: SweepLookups = prismaLookups): Promise<SweepResult> => {
  const result: SweepResult = { executions: [], images: [] };

  // KEEP_WORKSPACES keeps clones on purpose, for a person to look at.
  if (!config.keepWorkspaces) {
    const containers = await dockerLines(["ps", "-a", "--filter", "name=^agent-", "--format", "{{.Names}}"]);
    const found = [
      ...(await dockerLines(["images", "--filter", "reference=agent-env-*", "--filter", "reference=agent-build-tmp-*", "--format", "{{.Repository}}"])),
      ...containers,
      ...(await dockerLines(["network", "ls", "--filter", "name=^agent-net-", "--format", "{{.Name}}"])),
      ...(await fs.readdir(config.workspaceRoot).catch(() => [] as string[])),
    ];
    const ended = new Set(ids(found).length ? await lookups.endedExecutions(ids(found)) : []);
    for (const container of containers) {
      const id = idOf(container);
      if (id && ended.has(id)) await exec("docker", ["rm", "-f", container], { timeout: 60_000 }).catch(() => undefined);
    }
    for (const id of ended) {
      await removeWorkspace(id);
      await removeWorkspace(`${id}-publish`);
      await withImageLock(() => exec("docker", ["rmi", "-f", `agent-build-tmp-${id}`], { timeout: 60_000 }).catch(() => undefined));
      result.executions.push(id);
    }
  }

  // A repository's images are only removed while none of its executions
  // runs, so a run never loses the image it is about to start from.
  const images = (
    await dockerLines(["images", "--filter", "reference=agent-cache-*", "--filter", "reference=agent-build-*", "--format", "{{.Repository}}:{{.Tag}}"])
  ).filter((image) => !image.startsWith("agent-build-tmp-") && !image.endsWith(":<none>"));
  const idle = new Set(ids(images).length ? await lookups.idleRepositories(ids(images)) : []);
  for (const image of images) {
    const scope = idOf(image);
    if (!scope || !idle.has(scope)) continue;
    const [created] = await dockerLines(["image", "inspect", "--format", "{{.Created}}", image]);
    if (created && isFresh(created, config.executionSnapshotMaxAgeHours)) continue;
    // Without -f: an image a container still uses stays.
    try {
      await withImageLock(() => exec("docker", ["rmi", image], { timeout: 60_000 }));
      result.images.push(image);
    } catch {
      // In use, or already gone.
    }
  }
  return result;
};

let running: Promise<SweepResult> | null = null;
/** One sweep at a time: the timer and a run short of disk may ask together. */
const sweepOnce = () => {
  running ??= sweepEnvironments().finally(() => {
    running = null;
  });
  return running;
};

const sweepAndLog = () =>
  sweepOnce()
    .then(({ executions, images }) => {
      if (executions.length || images.length)
        console.log(`Environment sweep removed ${executions.length} ended run(s) and ${images.length} image(s)`);
    })
    .catch((error) => console.error(`Environment sweep failed: ${describeError(error)}`));

let timer: NodeJS.Timeout | null = null;
export const startEnvironmentSweep = () => {
  void sweepAndLog();
  timer = setInterval(() => void sweepAndLog(), SWEEP_INTERVAL_MS);
  timer.unref();
};
export const stopEnvironmentSweep = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/**
 * Stops a run before it fills the disk: below EXECUTION_MIN_FREE_DISK_GB the
 * sweep runs first, and the run fails only if that did not free enough.
 * shortcut: measures the disk holding WORKSPACE_ROOT, which is also Docker's
 * on Docker Desktop and on a single-disk server; check Docker's data root
 * too once it lives on another disk.
 */
export const ensureDiskSpace = async (
  sweep: () => Promise<unknown> = sweepOnce,
  free: () => Promise<number> = freeDiskBytes,
) => {
  const minimum = config.executionMinFreeDiskGb * 1e9;
  if (!minimum || (await free()) >= minimum) return;
  await sweep();
  const left = await free();
  if (left < minimum)
    throw new NonRetryableError(
      `Only ${(left / 1e9).toFixed(1)} GB is free on the disk that holds workspaces, below EXECUTION_MIN_FREE_DISK_GB (${config.executionMinFreeDiskGb}); free some space, then start the run again.`,
    );
};

const freeDiskBytes = async () => {
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  const stats = await fs.statfs(config.workspaceRoot);
  return stats.bavail * stats.bsize;
};
