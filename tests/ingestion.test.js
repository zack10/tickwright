const assert = require("node:assert/strict");
const test = require("node:test");

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const prisma = require("../dist/db").default;
const { registerTrackerAdapter } = require("../dist/integrations/trackerRegistry");
const { sealIntegrationConfig } = require("../dist/services/integrationConfigService");
const { syncIntegrationConnection } = require("../dist/services/ingestionService");

// A fake tracker with two eligible tickets; Prisma is stubbed, so no database is needed.
const setup = (completedWorkItems) => {
  const item = (id) => ({ externalId: id, boardId: "b", title: id, description: "", labels: [], sourceUrl: "", revisionHash: `moved-${id}`, rawSnapshot: {} });
  registerTrackerAdapter({
    type: "TRELLO",
    externalSystem: "TRELLO",
    fetchEligibleItems: async () => ({ repositoryId: "repo", items: [item("merged"), item("open")] }),
  });
  const created = [];
  prisma.integrationConnection = {
    findUniqueOrThrow: async () => ({ id: "c", type: "TRELLO", projectId: "p", encryptedConfig: sealIntegrationConfig({ repositoryId: "repo" }) }),
    update: async () => ({}),
  };
  prisma.workItem = { upsert: async ({ create }) => ({ id: `wi-${create.externalId}` }) };
  prisma.execution = {
    findFirst: async ({ where }) => (where.status === "COMPLETED" && completedWorkItems.includes(where.workItemId) ? { id: "done" } : null),
    // An existing execution per key, so createExecution returns it instead of writing.
    findUnique: async ({ where }) => {
      created.push(where.idempotencyKey);
      return { id: where.idempotencyKey };
    },
  };
  return created;
};

test("a ticket whose run opened its PR is not run again when the card changes, as moving it to Done does", async () => {
  const created = setup(["wi-merged"]);
  assert.deepEqual(await syncIntegrationConnection("c"), { ingested: 1 });
  assert.deepEqual(created, ["wi-open:moved-open"]);
});
