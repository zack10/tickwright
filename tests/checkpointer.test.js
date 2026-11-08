const assert = require("node:assert/strict");
const test = require("node:test");

const { Annotation, END, START, StateGraph } = require("@langchain/langgraph");
const { DurableCheckpointSaver } = require("../dist/services/agentGraph/checkpointer");

/** A store that keeps rows in a Map, like the GraphCheckpoint table. */
const memoryStore = () => {
  const rows = new Map();
  return {
    rows,
    load: async (id) => rows.get(id),
    save: async (id, data) => void rows.set(id, data),
    delete: async (id) => void rows.delete(id),
  };
};

/** clone → plan → attempt; attempt fails while `failures` is above zero. */
const buildGraph = (saver, calls, failures) => {
  const State = Annotation.Root({
    executionId: Annotation(),
    internalPlan: Annotation(),
    result: Annotation(),
  });
  return new StateGraph(State)
    .addNode("clone", async () => {
      calls.push("clone");
      return {};
    })
    .addNode("plan", async () => {
      calls.push("plan");
      return { internalPlan: "fix to_cents" };
    })
    .addNode("attempt", async (state) => {
      calls.push("attempt");
      if (failures.count-- > 0) throw new Error("read ECONNRESET");
      return { result: `done: ${state.internalPlan}` };
    })
    .addEdge(START, "clone")
    .addEdge("clone", "plan")
    .addEdge("plan", "attempt")
    .addEdge("attempt", END)
    .compile({ checkpointer: saver });
};

test("a failed run resumes at the step that failed, in a new process, without repeating earlier steps", async () => {
  const store = memoryStore();
  const thread = { configurable: { thread_id: "exec-1" } };
  const failures = { count: 1 };

  const first = [];
  await assert.rejects(buildGraph(new DurableCheckpointSaver(store), first, failures).invoke({ executionId: "exec-1" }, thread), /ECONNRESET/);
  assert.deepEqual(first, ["clone", "plan", "attempt"]);
  assert.ok(store.rows.has("exec-1"), "progress is stored");

  // A new saver has nothing in memory: everything comes from the store.
  const second = [];
  const graph = buildGraph(new DurableCheckpointSaver(store), second, failures);
  const saved = await graph.getState(thread);
  assert.deepEqual(saved.next, ["attempt"]);
  assert.equal(saved.values.internalPlan, "fix to_cents", "earlier steps' results are restored");
  const final = await graph.invoke(null, thread);
  assert.deepEqual(second, ["attempt"], "clone and plan are not run again");
  assert.equal(final.result, "done: fix to_cents");
});

test("evict rereads the stored copy; deleteThread removes it; only the latest checkpoints are kept", async () => {
  const store = memoryStore();
  const saver = new DurableCheckpointSaver(store);
  const thread = { configurable: { thread_id: "exec-2" } };
  await buildGraph(saver, [], { count: 0 }).invoke({ executionId: "exec-2" }, thread);

  const stored = JSON.parse(store.rows.get("exec-2"));
  assert.ok(Object.keys(stored.storage[""]).length <= 2, "older checkpoints are pruned");

  saver.evict("exec-2");
  assert.equal(saver.storage["exec-2"], undefined);
  assert.deepEqual((await buildGraph(saver, [], { count: 0 }).getState(thread)).values.result, "done: fix to_cents");

  await saver.deleteThread("exec-2");
  assert.equal(store.rows.has("exec-2"), false);
  assert.deepEqual((await buildGraph(saver, [], { count: 0 }).getState(thread)).next, []);
});
