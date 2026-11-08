// Smoke suite: needs only a running server (Postgres + RabbitMQ up). No
// third-party credentials.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, describe, test } = require("node:test");

const { api, assertServerHealthy, env, runId } = require("./helpers");

describe("smoke", () => {
  const id = runId();
  const created = [];

  before(assertServerHealthy);

  after(async () => {
    for (const projectId of created)
      await api("DELETE", `/api/projects/${projectId}`).catch(() => undefined);
  });

  test("health reports database and rabbitmq ok", async () => {
    const { data } = await api("GET", "/health", { expectStatus: 200 });
    assert.deepEqual(data, { status: "healthy", version: require("../../package.json").version, checks: { database: "ok", rabbitmq: "ok" } });
  });

  test(
    "API rejects requests without a bearer token",
    { skip: env("E2E_API_TOKEN") ? false : "E2E_API_TOKEN not set (server assumed AUTH_DISABLED)" },
    async () => {
      await api("GET", "/api/projects", { auth: false, expectStatus: 401 });
      await api("GET", "/api/projects", { auth: false, headers: { authorization: "Bearer wrong" }, expectStatus: 401 });
    },
  );

  test("project lifecycle: create, read, delete", async () => {
    const { data: project } = await api("POST", "/api/projects", {
      body: { name: `${id}-project`, description: "smoke" },
      expectStatus: 201,
    });
    created.push(project.id);

    const { data: fetched } = await api("GET", `/api/projects/${project.id}`, { expectStatus: 200 });
    assert.equal(fetched.name, `${id}-project`);

    await api("DELETE", `/api/projects/${project.id}`, { expectStatus: 204 });
    created.pop();
    await api("GET", `/api/projects/${project.id}`, { expectStatus: 404 });
  });

  test("validation rejects bad input with 400", async () => {
    await api("POST", "/api/projects", { body: {}, expectStatus: 400 });
    await api("GET", "/api/projects/not-a-uuid", { expectStatus: 400 });
    await api("POST", `/api/executions/${crypto.randomUUID()}/approvals/plan`, {
      body: { approved: true, snapshotHash: "short" },
      expectStatus: 400,
    });
  });

  test("unknown ids return 404", async () => {
    await api("GET", `/api/projects/${crypto.randomUUID()}`, { expectStatus: 404 });
  });

  test("syncing a non-tracker integration is refused with 400", async () => {
    const { data: project } = await api("POST", "/api/projects", {
      body: { name: `${id}-sync` },
      expectStatus: 201,
    });
    created.push(project.id);
    const { data: integration } = await api("POST", "/api/integrations", {
      body: { projectId: project.id, type: "GITHUB", name: `${id}-github`, config: { note: "smoke" } },
      expectStatus: 201,
    });
    assert.equal(JSON.stringify(integration).includes("smoke"), false, "integration config must be redacted");
    await api("POST", `/api/integrations/${integration.id}/sync`, { expectStatus: 400 });
  });
});
