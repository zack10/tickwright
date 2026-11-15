const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

const { ProviderRegistry, parseProviderProfiles } = require("../dist/services/llm/registry");
const { LLMService } = require("../dist/services/llm/LLMService");
const { TokenLimitError, startOfUtcDay } = require("../dist/services/llm/usageLedger");
const { NonRetryableError } = require("../dist/utils/safeError");

const registry = new ProviderRegistry(
  parseProviderProfiles(JSON.stringify([{ key: "local", baseUrl: "http://localhost:11434/v1" }]), {}, "development"),
  "local",
  "llama3",
);

/** An in-memory ledger; `earlier` is usage already recorded today. */
const memoryLedger = (earlier = 0) => {
  const entries = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
    async tokensUsedSince() {
      return earlier + entries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    },
    async tokensUsedByExecution(id) {
      return entries.filter((e) => e.executionId === id).reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    },
  };
};

/** Answers every chat completion with `usage` and counts the requests. */
const fakeCompletions = (t, usage = { prompt_tokens: 300, completion_tokens: 50 }) => {
  const calls = { count: 0 };
  const original = axios.post;
  axios.post = async () => {
    calls.count++;
    return { data: { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage } };
  };
  t.after(() => {
    axios.post = original;
  });
  return calls;
};

test("every call's tokens are recorded with what it was for", async (t) => {
  fakeCompletions(t);
  const ledger = memoryLedger();
  const llm = new LLMService(registry, ledger, 0);
  await llm.generateContent("local", "llama3", { user: "hi" }, undefined, { purpose: "plan.v1", executionId: "e1" });
  await llm.generateContent("local", "llama3", { user: "hi" });
  assert.ok(ledger.entries.every((e) => /^[0-9a-f-]{36}$/.test(e.id)), "each usage row gets the id its call records point at");
  assert.deepEqual(ledger.entries.map(({ id: _id, ...entry }) => entry), [
    { provider: "local", model: "llama3", purpose: "plan.v1", executionId: "e1", taskId: undefined, inputTokens: 300, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 },
    { provider: "local", model: "llama3", purpose: "unattributed", executionId: undefined, taskId: undefined, inputTokens: 300, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 },
  ]);
});

test("tool calls are recorded too", async (t) => {
  const original = axios.post;
  axios.post = async () => ({
    data: { choices: [{ finish_reason: "stop", message: { content: "done" } }], usage: { prompt_tokens: 40, completion_tokens: 2 } },
  });
  t.after(() => {
    axios.post = original;
  });
  const toolRegistry = new ProviderRegistry(
    parseProviderProfiles(JSON.stringify([{ key: "local", baseUrl: "http://localhost:11434/v1", supportsTools: true }]), {}, "development"),
    "local",
    "llama3",
  );
  const ledger = memoryLedger();
  await new LLMService(toolRegistry, ledger, 0).generateWithTools(
    "local",
    "llama3",
    { messages: [{ role: "user", content: "hi" }], tools: [] },
    undefined,
    { purpose: "agent.v2", executionId: "e1" },
  );
  assert.equal(ledger.entries[0].purpose, "agent.v2");
  assert.equal(ledger.entries[0].inputTokens, 40);
});

test("the daily limit refuses new calls once reached, across all callers", async (t) => {
  const calls = fakeCompletions(t);
  const ledger = memoryLedger(600);
  const llm = new LLMService(registry, ledger, 1000);

  await llm.generateContent("local", "llama3", { user: "hi" }); // 600 used: allowed, now 950
  await llm.generateContent("local", "llama3", { user: "hi" }); // 950 used: allowed, now 1300
  const refused = llm.generateContent("local", "llama3", { user: "hi" });
  await assert.rejects(refused, (error) => {
    assert.ok(error instanceof TokenLimitError);
    assert.ok(error instanceof NonRetryableError, "consumers must not retry it");
    assert.match(error.message, /Daily LLM token limit reached: 1300 of 1000 tokens/);
    assert.match(error.message, /resets at \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
    return true;
  });
  assert.equal(calls.count, 2, "the refused call never reached the provider");
});

test("a limit of 0 switches the daily limit off", async (t) => {
  fakeCompletions(t);
  const llm = new LLMService(registry, memoryLedger(10_000_000), 0);
  assert.equal(await llm.generateContent("local", "llama3", { user: "hi" }), "ok");
});

test("a failed usage write is logged, not thrown: the call already happened", async (t) => {
  fakeCompletions(t);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  t.after(() => {
    console.error = originalError;
  });
  const ledger = { ...memoryLedger(), record: async () => Promise.reject(new Error("db down")) };
  assert.equal(await new LLMService(registry, ledger, 0).generateContent("local", "llama3", { user: "hi" }), "ok");
  assert.match(errors[0], /Recording LLM usage failed: Error: db down/);
});

test("usageToday reports the UTC day and when it resets", async () => {
  const llm = new LLMService(registry, memoryLedger(1234), 5000);
  const today = await llm.usageToday();
  assert.equal(today.used, 1234);
  assert.equal(today.limit, 5000);
  assert.equal(today.resetsAt.getTime() - startOfUtcDay().getTime(), 24 * 60 * 60 * 1000);
  assert.equal(startOfUtcDay(new Date("2026-10-26T23:59:59.000Z")).toISOString(), "2026-10-26T00:00:00.000Z");
});

/** Resolves once `count` calls have been recorded (the write is not awaited by the call). */
const recordedCalls = (ledger, count) =>
  new Promise((resolve) => {
    const check = () => (ledger.calls.length >= count ? resolve(ledger.calls) : setImmediate(check));
    check();
  });

test("each try of a model call is recorded with its request and reply or error, failed tries too", async (t) => {
  let tries = 0;
  const original = axios.post;
  axios.post = async () => {
    if (++tries === 1) {
      const error = new axios.AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE");
      error.response = { status: 500, data: { error: { message: "overloaded" } }, headers: {} };
      throw error;
    }
    return { data: { choices: [{ finish_reason: "stop", message: { content: "fixed" } }], usage: { prompt_tokens: 40, completion_tokens: 2 } } };
  };
  t.after(() => {
    axios.post = original;
  });
  const toolRegistry = new ProviderRegistry(
    parseProviderProfiles(JSON.stringify([{ key: "local", baseUrl: "http://localhost:11434/v1", supportsTools: true }]), {}, "development"),
    "local",
    "llama3",
  );
  const ledger = { ...memoryLedger(), calls: [], async recordCall(entry) { this.calls.push(entry); } };
  const assistant = { role: "assistant", content: "", toolCalls: [], raw: { provider: "local", content: "big" } };
  const turn = await new LLMService(toolRegistry, ledger, 0).generateWithTools(
    "local",
    "llama3",
    { system: "be careful", messages: [{ role: "user", content: "hi" }, assistant], tools: [{ name: "read_file", description: "d", parameters: {} }] },
    undefined,
    { purpose: "agent.v2", executionId: "e1" },
  );
  assert.equal(turn.text, "fixed");
  const [failed, passed] = await recordedCalls(ledger, 2);

  assert.deepEqual([failed.try, passed.try], [1, 2]);
  assert.equal(failed.usageId, passed.usageId);
  assert.equal(passed.usageId, ledger.entries[0].id, "both tries point at the call's usage row");
  assert.equal(failed.errorType, "500");
  assert.match(failed.error, /500.*overloaded/);
  assert.equal(failed.outputMessages, undefined);
  assert.equal(passed.operation, "chat");
  assert.equal(passed.systemInstructions, "be careful");
  assert.equal(passed.inputMessages[1].raw, undefined, "the raw reply is not repeated in later requests");
  assert.deepEqual(passed.toolDefinitions, [{ name: "read_file", description: "d", parameters: {} }]);
  assert.equal(passed.outputMessages[0].content, "fixed");
  assert.equal(passed.outputMessages[0].finishReason, "end_turn");
  assert.ok(passed.durationMs >= 0 && passed.startedAt instanceof Date);
  assert.equal(passed.executionId, "e1");
});

test("a failed call write changes neither the reply nor the error of the call", async (t) => {
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  t.after(() => {
    console.error = originalError;
  });
  const ledger = { ...memoryLedger(), recordCall: () => { throw new Error("db down"); } };
  fakeCompletions(t);
  assert.equal(await new LLMService(registry, ledger, 0).generateContent("local", "llama3", { user: "hi" }), "ok");

  const original = axios.post;
  axios.post = async () => {
    const error = new axios.AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST");
    error.response = { status: 401, data: {}, headers: {} };
    throw error;
  };
  await assert.rejects(new LLMService(registry, ledger, 0).generateContent("local", "llama3", { user: "hi" }), NonRetryableError);
  axios.post = original;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.filter((line) => /Recording LLM call failed: Error: db down/.test(line)).length, 2);
});
