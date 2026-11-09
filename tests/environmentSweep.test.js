const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Must be set before config is loaded.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-sweep-"));
process.env.WORKSPACE_ROOT = workspaceRoot;
delete process.env.KEEP_WORKSPACES;

const { ensureDiskSpace, sweepEnvironments } = require("../dist/services/environmentSweep");
const { NonRetryableError } = require("../dist/utils/safeError");

const GB = 1e9;

test("a run short of disk sweeps first, and stops only if that did not free enough", async () => {
  let sweeps = 0;
  const sweep = async () => sweeps++;
  await ensureDiskSpace(sweep, async () => 50 * GB);
  assert.equal(sweeps, 0, "enough space: no sweep");

  const after = [2 * GB, 20 * GB];
  await ensureDiskSpace(sweep, async () => after.shift());
  assert.equal(sweeps, 1, "the sweep freed enough");

  await assert.rejects(
    ensureDiskSpace(sweep, async () => 2 * GB),
    (error) => error instanceof NonRetryableError && /2\.0 GB is free[\s\S]*EXECUTION_MIN_FREE_DISK_GB \(10\)/.test(error.message),
  );
});

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const exists = (kind, name) => docker(kind, "inspect", name).status === 0;

test(
  "the sweep removes what ended runs and idle repositories left, and nothing it does not know",
  { skip: docker("version").status === 0 ? false : "Docker is not available" },
  async (t) => {
    const [ended, running, unknown, idleRepo, busyRepo] = Array.from({ length: 5 }, () => crypto.randomUUID());
    // `docker tag` does not pull, unlike `docker run`; a fresh CI runner has no image yet.
    if (!exists("image", "alpine:3.20")) assert.equal(docker("pull", "alpine:3.20").status, 0, "pull alpine:3.20");
    const made = { images: [], containers: [], networks: [] };
    t.after(() => {
      for (const container of made.containers) docker("rm", "-f", container);
      for (const image of made.images) docker("rmi", "-f", image);
      for (const network of made.networks) docker("network", "rm", network);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });
    const tag = (image) => {
      assert.equal(docker("tag", "alpine:3.20", image).status, 0);
      made.images.push(image);
    };

    // What runs leave: a snapshot, a setup container, a network, a clone.
    for (const id of [ended, running, unknown]) {
      tag(`agent-env-${id}`);
      assert.equal(docker("create", "--name", `agent-setup-${id}`, "alpine:3.20", "true").status, 0);
      made.containers.push(`agent-setup-${id}`);
      assert.equal(docker("network", "create", "--internal", `agent-net-${id}`).status, 0);
      made.networks.push(`agent-net-${id}`);
      fs.mkdirSync(path.join(workspaceRoot, id));
    }
    // Repository images: alpine's tags are years old, a commit is new.
    tag(`agent-cache-${idleRepo}:old`);
    tag(`agent-build-${idleRepo}:old`);
    tag(`agent-cache-${busyRepo}:old`);
    tag(`agent-cache-${unknown}:old`);
    assert.equal(docker("commit", `agent-setup-${unknown}`, `agent-cache-${idleRepo}:new`).status, 0);
    made.images.push(`agent-cache-${idleRepo}:new`);

    const asked = [];
    const result = await sweepEnvironments({
      endedExecutions: async (ids) => (asked.push(...ids), ids.filter((id) => id === ended)),
      idleRepositories: async (ids) => ids.filter((id) => id === idleRepo),
    });

    assert.ok(asked.includes(running) && asked.includes(unknown), "every id found is looked up");
    assert.deepEqual(result.executions, [ended]);
    assert.ok(!exists("image", `agent-env-${ended}`) && !exists("container", `agent-setup-${ended}`));
    assert.ok(!exists("network", `agent-net-${ended}`) && !fs.existsSync(path.join(workspaceRoot, ended)));
    for (const id of [running, unknown]) {
      assert.ok(exists("image", `agent-env-${id}`) && exists("container", `agent-setup-${id}`), `${id} kept`);
      assert.ok(exists("network", `agent-net-${id}`) && fs.existsSync(path.join(workspaceRoot, id)));
    }

    assert.deepEqual(result.images.sort(), [`agent-build-${idleRepo}:old`, `agent-cache-${idleRepo}:old`]);
    assert.ok(exists("image", `agent-cache-${idleRepo}:new`), "a fresh cache stays");
    assert.ok(exists("image", `agent-cache-${busyRepo}:old`), "a repository with a run in progress keeps its images");
    assert.ok(exists("image", `agent-cache-${unknown}:old`), "another instance's repository is not touched");
  },
);
