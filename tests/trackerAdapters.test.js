const assert = require("node:assert/strict");
const test = require("node:test");

const { toWorkItems, trelloAdapter } = require("../dist/integrations/trelloAdapter");
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

test("Trello revision hash is unchanged by the adapter refactor", () => {
  // Pinned from the pre-refactor formula. If this fails, every existing card
  // gets a new execution idempotency key and is re-run.
  const [item] = toWorkItems([card()], config);
  assert.equal(
    item.revisionHash,
    "c7e63005e826ae4df14c0623bcfb7258c5bac9c0eae6142488425949ffafd131",
  );
});

test("Trello revision hash ignores label fields that change with other cards", () => {
  const label = (uses, color) => ({ id: "label-1", name: "Agent", uses, color });
  const [before] = toWorkItems([card({ labels: [label(10, "sky")] })], config);
  const [after] = toWorkItems([card({ labels: [label(11, "green")] })], config);
  const [renamed] = toWorkItems([card({ labels: [{ ...label(11), name: "agent" }] })], config);
  assert.equal(after.revisionHash, before.revisionHash);
  assert.notEqual(renamed.revisionHash, before.revisionHash);
});

test("Trello adapter keeps only cards with the eligible label (case-insensitive)", () => {
  const items = toWorkItems(
    [card(), card({ id: "card-2", labels: [{ name: "Other" }] }), card({ id: "card-3", labels: [] })],
    config,
  );
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["card-1"],
  );
});

test("Trello adapter maps cards to the normalized work item shape", () => {
  const [item] = toWorkItems([card()], config);
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
