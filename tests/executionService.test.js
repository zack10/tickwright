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

// A round waiting for publish approval, inside a stubbed transaction that records every write.
const stubRound = (t, execution) => {
  const writes = [];
  const record = (name) => async (args) => (writes.push([name, args]), { count: 1 });
  const tx = {
    execution: { findUnique: async () => execution, updateMany: record("execution.updateMany") },
    approval: { findFirst: async () => ({ id: "ap1", snapshotHash: "hash" }), updateMany: record("approval.updateMany") },
    executionFeedback: { updateMany: async (args) => (writes.push(["feedback.updateMany", args]), { count: 3 }), create: record("feedback.create") },
    executionEvent: { findFirst: async () => ({ sequence: 9 }), create: record("event.create") },
  };
  const real = prisma.$transaction;
  prisma.$transaction = async (fn) => fn(tx);
  t.after(() => (prisma.$transaction = real));
  return writes;
};

test("a follow-up round's change rejected with feedback ends unpublished, and its feedback and findings wait again with the person's feedback", async (t) => {
  const { requestChangeRevision } = require("../dist/services/executionService");
  const writes = stubRound(t, { id: "round", parentExecutionId: "root", status: "AWAITING_PUBLISH_APPROVAL", correlationId: "c" });
  assert.deepEqual(await requestChangeRevision("round", "hash", "trello:zack", "The test must fail without the fix."), { revised: true });
  const write = (name) => writes.filter(([n]) => n === name).map(([, args]) => args);
  assert.equal(write("execution.updateMany")[0].data.status, "CANCELED");
  // Everything the round addressed waits again, its answers cleared so they are never posted.
  assert.deepEqual(write("feedback.updateMany"), [{
    where: { addressedByExecutionId: "round" },
    data: { addressedByExecutionId: null, verdict: null, verdictNote: null, repliedAt: null },
  }]);
  const [{ data: stored }] = write("feedback.create");
  assert.deepEqual(
    { executionId: stored.executionId, externalId: stored.externalId, author: stored.author, body: stored.body, requestsChanges: stored.requestsChanges },
    { executionId: "root", externalId: "publish-rejection:ap1", author: "zack", body: "The test must fail without the fix.", requestsChanges: true },
  );
  assert.equal(write("event.create")[0].data.type, "CHANGE_REVISION_REQUESTED");
});

test("a first change cannot be revised by rejecting it: it has no pull request for a new round", async (t) => {
  const { requestChangeRevision } = require("../dist/services/executionService");
  const writes = stubRound(t, { id: "first", parentExecutionId: null, status: "AWAITING_PUBLISH_APPROVAL", correlationId: "c" });
  await assert.rejects(requestChangeRevision("first", "hash", "api", "redo it"), /Only a follow-up round's change can be revised/);
  assert.deepEqual(writes, [], "nothing was changed");
});
