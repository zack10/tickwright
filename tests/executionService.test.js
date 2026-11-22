const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");

const prisma = require("../dist/db").default;
const { createExecution } = require("../dist/services/executionService");

const input = { projectId: "p", workItemId: "wi", repositoryId: "r", revisionHash: "rev" };
const duplicate = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });

test("an execution another sync created at the same moment is returned, not reported as a conflict", async () => {
  const lookups = [null, { id: "made-by-the-poller" }];
  prisma.execution = { findUnique: async () => lookups.shift() };
  prisma.$transaction = async () => {
    throw duplicate();
  };
  assert.deepEqual(await createExecution(input), { id: "made-by-the-poller" });
});

test("a unique-constraint failure with no execution to return is still an error", async () => {
  prisma.execution = { findUnique: async () => null };
  prisma.$transaction = async () => {
    throw duplicate();
  };
  await assert.rejects(createExecution(input), (error) => error.code === "P2002");
});
