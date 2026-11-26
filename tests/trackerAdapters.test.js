const assert = require("node:assert/strict");
const test = require("node:test");

const { readyListIds, toWorkItems, trelloAdapter } = require("../dist/integrations/trelloAdapter");
const {
  getTrackerAdapter,
  getTrackerAdapterForSystem,
  registerTrackerAdapter,
  trackerIntegrationTypes,
} = require("../dist/integrations/trackerRegistry");

const card = (overrides = {}) => ({
  id: "card-1",
  name: "Fix login bug",
  desc: "Users get 500 on /login",
  url: "https://trello.com/c/abc",
  idList: "list-1",
  labels: [{ name: "Agent" }],
  ...overrides,
});
const config = { boardId: "board-1", eligibleLabel: "agent" };
const READY = new Set(["list-1"]);

test("Trello revision hash is unchanged by the adapter refactor", () => {
  // Pinned from the pre-refactor formula. If this fails, every existing card
  // gets a new execution idempotency key and is re-run.
  const [item] = toWorkItems([card()], config, READY);
  assert.equal(
    item.revisionHash,
    "c7e63005e826ae4df14c0623bcfb7258c5bac9c0eae6142488425949ffafd131",
  );
});

test("Trello revision hash ignores label fields that change with other cards", () => {
  const label = (uses, color) => ({ id: "label-1", name: "Agent", uses, color });
  const [before] = toWorkItems([card({ labels: [label(10, "sky")] })], config, READY);
  const [after] = toWorkItems([card({ labels: [label(11, "green")] })], config, READY);
  const [renamed] = toWorkItems([card({ labels: [{ ...label(11), name: "agent" }] })], config, READY);
  assert.equal(after.revisionHash, before.revisionHash);
  assert.notEqual(renamed.revisionHash, before.revisionHash);
});

test("Trello adapter keeps only cards with the eligible label (case-insensitive)", () => {
  const items = toWorkItems(
    [card(), card({ id: "card-2", labels: [{ name: "Other" }] }), card({ id: "card-3", labels: [] })],
    config,
    READY,
  );
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["card-1"],
  );
});

test("a labelled card outside the ready lists, such as one in Backlog, is not picked up", () => {
  const items = toWorkItems([card(), card({ id: "card-2", idList: "backlog" })], config, READY);
  assert.deepEqual(items.map((item) => item.externalId), ["card-1"]);
});

test("ready lists are found by name, ignoring case, and a name the board lacks is an error", () => {
  const lists = [{ id: "list-1", name: "Ready for Agent" }, { id: "list-2", name: "Ready for dev" }, { id: "list-3", name: "Backlog" }];
  assert.deepEqual([...readyListIds(lists, ["ready for agent", "Ready for Dev"])], ["list-1", "list-2"]);
  assert.throws(() => readyListIds(lists, ["Ready"]), /Trello list "Ready" is not on the board \(lists: Ready for Agent, Ready for dev, Backlog\)/);
  // A connection stored before ready lists existed picks up nothing until it names them.
  assert.throws(() => readyListIds(lists, undefined), /names no ready lists/);
});

test("Trello adapter maps cards to the normalized work item shape", () => {
  const [item] = toWorkItems([card()], config, READY);
  assert.deepEqual(
    { ...item, revisionHash: undefined, rawSnapshot: undefined },
    {
      externalId: "card-1",
      boardId: "board-1",
      title: "Fix login bug",
      description: "Users get 500 on /login",
      labels: [{ name: "Agent" }],
      sourceUrl: "https://trello.com/c/abc",
      revisionHash: undefined,
      rawSnapshot: undefined,
    },
  );
});

test("registry resolves Trello by integration type and external system", () => {
  assert.equal(getTrackerAdapter("TRELLO"), trelloAdapter);
  assert.equal(getTrackerAdapterForSystem("TRELLO"), trelloAdapter);
  assert.deepEqual(trackerIntegrationTypes(), ["TRELLO"]);
});

test("registry treats non-tracker integrations as unsupported for sync", () => {
  assert.equal(getTrackerAdapter("GITHUB"), undefined);
  assert.equal(getTrackerAdapterForSystem("JIRA"), undefined);
});

test("new adapters plug in through registerTrackerAdapter", () => {
  const fake = {
    type: "FAKE",
    externalSystem: "FAKE",
    fetchEligibleItems: async () => ({ repositoryId: "r", items: [] }),
    comment: async () => undefined,
  };
  registerTrackerAdapter(fake);
  assert.equal(getTrackerAdapter("FAKE"), fake);
  assert.equal(getTrackerAdapterForSystem("FAKE"), fake);
  assert.ok(trackerIntegrationTypes().includes("FAKE"));
});

test("a Trello connection must name its key, token, board, label, ready lists and repository", () => {
  const good = { apiKey: "k", token: "t", boardId: "b", eligibleLabel: "agent", eligibleLists: ["Ready for Agent"], repositoryId: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", approvers: ["alice"] };
  assert.equal(trelloAdapter.configSchema.safeParse(good).success, true);
  for (const key of ["apiKey", "token", "boardId", "eligibleLabel", "eligibleLists", "repositoryId"]) {
    const { [key]: _omitted, ...missing } = good;
    assert.equal(trelloAdapter.configSchema.safeParse(missing).success, false, key);
  }
  assert.equal(trelloAdapter.configSchema.safeParse({ ...good, repositoryId: "not-a-uuid" }).success, false);
  assert.equal(trelloAdapter.configSchema.safeParse({ ...good, eligibleLists: [] }).success, false, "at least one ready list");
});

test("creating a connection with a config its adapter rejects answers 400 and stores nothing", async () => {
  process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const prisma = require("../dist/db").default;
  const { createIntegration } = require("../dist/controllers/executionController");
  const real = prisma.integrationConnection;
  const created = [];
  prisma.integrationConnection = { create: async ({ data }) => (created.push(data), { id: "c1", ...data }) };
  const call = (config) =>
    new Promise((resolve) => {
      const res = { status: () => res, json: (body) => resolve({ body }) };
      createIntegration({ body: { projectId: "p", type: "TRELLO", name: "n", config } }, res, (error) => resolve({ error }));
    });
  try {
    const rejected = await call({ apiKey: "k", token: "t", eligibleLabel: "agent" });
    assert.equal(rejected.error.statusCode, 400);
    assert.match(rejected.error.message, /Invalid TRELLO connection config: .*boardId/);
    assert.equal(created.length, 0);
    const accepted = await call({ apiKey: "k", token: "t", boardId: "b", eligibleLabel: "agent", eligibleLists: ["Ready"], repositoryId: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" });
    assert.equal(accepted.error, undefined);
    assert.equal(created.length, 1);
  } finally {
    prisma.integrationConnection = real;
  }
});

test("updating a connection merges the given settings into the stored config, checks the result, and returns no secrets", async () => {
  process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const prisma = require("../dist/db").default;
  const { updateIntegration } = require("../dist/controllers/executionController");
  const { openIntegrationConfig, sealIntegrationConfig } = require("../dist/services/integrationConfigService");
  const real = prisma.integrationConnection;
  // Stored before ready lists existed.
  const stored = { apiKey: "k", token: "secret-token", boardId: "b", eligibleLabel: "agent", repositoryId: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", approvers: ["alice"] };
  let row = { id: "c1", type: "TRELLO", name: "n", enabled: true, encryptedConfig: sealIntegrationConfig(stored) };
  prisma.integrationConnection = {
    findUnique: async () => row,
    update: async ({ data }) => (row = { ...row, ...data }),
  };
  const call = (body) =>
    new Promise((resolve) => {
      const res = { status: () => res, json: (sent) => resolve({ sent }) };
      updateIntegration({ params: { id: "c1" }, body }, res, (error) => resolve({ error }));
    });
  try {
    const rejected = await call({ config: { eligibleLists: [] } });
    assert.equal(rejected.error.statusCode, 400);
    assert.deepEqual(openIntegrationConfig(row.encryptedConfig), stored, "a rejected change stores nothing");

    const { sent, error } = await call({ config: { eligibleLists: ["Ready for Agent"] } });
    assert.equal(error, undefined);
    assert.deepEqual(openIntegrationConfig(row.encryptedConfig), { ...stored, eligibleLists: ["Ready for Agent"] });
    assert.doesNotMatch(JSON.stringify(sent), /secret-token|ciphertext/);
  } finally {
    prisma.integrationConnection = real;
  }
});
