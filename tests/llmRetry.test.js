const assert = require("node:assert/strict");
const test = require("node:test");

const { isRetryableLLMError, retryDelayMs, withLLMRetry } = require("../dist/services/llm/retry");

const httpError = (status, { headers = {}, data } = {}) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, headers, data },
});

test("rate limits and overloads are retryable; exhausted credits and other errors are not", () => {
  assert.equal(isRetryableLLMError(httpError(429)), true);
  assert.equal(isRetryableLLMError(httpError(503)), true);
  assert.equal(isRetryableLLMError(httpError(529)), true);
  assert.equal(isRetryableLLMError(httpError(400)), false);
  assert.equal(isRetryableLLMError(new Error("boom")), false);
  assert.equal(
    isRetryableLLMError(httpError(429, { data: { error: { type: "insufficient_quota", code: "credit_balance_exhausted" } } })),
    false,
  );
});

test("retry delay honours Retry-After, then Gemini RetryInfo, then backs off (capped)", () => {
  assert.equal(retryDelayMs(httpError(429, { headers: { "retry-after": "7" } }), 0), 7000);
  assert.equal(
    retryDelayMs(httpError(429, { data: { error: { details: [{ "@type": "RetryInfo", retryDelay: "37s" }] } } }), 0),
    38_000,
  );
  assert.equal(retryDelayMs(httpError(429), 0), 10_000);
  assert.equal(retryDelayMs(httpError(429), 1), 20_000);
  assert.equal(retryDelayMs(httpError(429, { headers: { "retry-after": "600" } }), 0), 60_000);
});

test("withLLMRetry retries retryable failures up to the limit, then rethrows", async () => {
  const waits = [];
  let calls = 0;
  const result = await withLLMRetry(
    async () => {
      calls++;
      if (calls < 3) throw httpError(429);
      return "ok";
    },
    { retries: 3, wait: async (ms) => waits.push(ms) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10_000, 20_000]);

  calls = 0;
  await assert.rejects(
    withLLMRetry(async () => { calls++; throw httpError(429); }, { retries: 2, wait: async () => undefined }),
    (error) => error.response.status === 429,
  );
  assert.equal(calls, 3);
});

test("withLLMRetry fails fast, non-retryably, on exhausted credits or long quota resets", async () => {
  const { NonRetryableError } = require("../dist/utils/safeError");
  const cases = [
    httpError(429, { data: { error: { type: "insufficient_quota", code: "credit_balance_exhausted" } } }),
    httpError(429, { data: { error: { details: [{ "@type": "RetryInfo", retryDelay: "15525s" }] } } }),
  ];
  for (const failure of cases) {
    let calls = 0;
    await assert.rejects(
      withLLMRetry(async () => { calls++; throw failure; }, { retries: 3, wait: async () => undefined }),
      (error) => error instanceof NonRetryableError,
    );
    assert.equal(calls, 1);
  }
});

test("withLLMRetry does not retry permanent failures", async () => {
  let calls = 0;
  await assert.rejects(
    withLLMRetry(async () => { calls++; throw httpError(401); }, { retries: 3, wait: async () => undefined }),
  );
  assert.equal(calls, 1);
});

test("dropped connections, timeouts and server errors are retried with jittered backoff", async () => {
  const network = (code) => ({ isAxiosError: true, code, message: code });
  for (const failure of [network("ECONNRESET"), network("ETIMEDOUT"), httpError(500), httpError(502), httpError(408)]) {
    assert.equal(isRetryableLLMError(failure), true, failure.code ?? failure.response.status);
    let calls = 0;
    const result = await withLLMRetry(
      async () => {
        if (++calls < 2) throw failure;
        return "ok";
      },
      { retries: 3, wait: async () => undefined },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  }
  assert.equal(retryDelayMs(network("ECONNRESET"), 0, () => 0), 500);
  assert.equal(retryDelayMs(network("ECONNRESET"), 2, () => 1), 4000);
  assert.equal(retryDelayMs(httpError(500), 10, () => 1), 30_000, "capped");
});

test("a rejected request fails at once with the provider's reason, keys masked", async () => {
  const { NonRetryableError } = require("../dist/utils/safeError");
  const rejected = httpError(400, {
    data: { error: { message: "Invalid 'messages[3].tool_call_id': no tool call found. Key sk-proj-abcdefghijklmnopqrstuvwxyz0123 was used." } },
  });
  let calls = 0;
  await assert.rejects(
    withLLMRetry(async () => { calls++; throw rejected; }, { retries: 3, wait: async () => undefined }),
    (error) =>
      error instanceof NonRetryableError &&
      /no tool call found/.test(error.message) &&
      !/abcdefghijklmnop/.test(error.message) &&
      /\[redacted\]/.test(error.message),
  );
  assert.equal(calls, 1);
  // Errors that are not HTTP failures (e.g. unusable output) pass through unchanged.
  const output = new Error("empty response");
  await assert.rejects(withLLMRetry(async () => { throw output; }, { retries: 3 }), (error) => error === output);
});

test("a request the safety filter flagged is retried once, then fails with the reason", async () => {
  const { NonRetryableError } = require("../dist/utils/safeError");
  const flagged = httpError(400, {
    data: { error: { code: "invalid_prompt", message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy." } },
  });
  let calls = 0;
  const waits = [];
  const result = await withLLMRetry(
    async () => {
      if (++calls === 1) throw flagged;
      return "ok";
    },
    { retries: 3, wait: async (ms) => waits.push(ms) },
  );
  assert.equal(result, "ok");
  assert.deepEqual(waits, [2000]);

  calls = 0;
  await assert.rejects(
    withLLMRetry(async () => { calls++; throw flagged; }, { retries: 3, wait: async () => undefined }),
    (error) => error instanceof NonRetryableError && /flagged/.test(error.message),
  );
  assert.equal(calls, 2, "only one retry");
});
