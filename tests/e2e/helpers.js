// Shared helpers for the end-to-end suites. These talk to a RUNNING server over
// HTTP (and to Trello/GitHub directly for setup, assertions and cleanup), so
// they never import from dist/.
const assert = require("node:assert/strict");
const test = require("node:test");

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};
const envInt = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);

/** `false` when every variable is set, otherwise a skip reason naming the missing ones. */
const skipUnless = (names) => {
  const missing = names.filter((name) => !env(name));
  return missing.length ? `set ${missing.join(", ")} to run this suite` : false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const truncate = (text, max = 600) =>
  text && text.length > max ? `${text.slice(0, max)}...` : text;

/** Unique, sortable id so records from different runs never collide. */
const runId = () => `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const baseUrl = () => env("E2E_BASE_URL", "http://localhost:3001").replace(/\/$/, "");

/**
 * Calls the API under test. Pass `expectStatus` to assert the status code;
 * the failure message includes the response body for quick diagnosis.
 */
const api = async (method, path, { body, headers = {}, auth = true, expectStatus } = {}) => {
  const token = env("E2E_API_TOKEN");
  const send = () =>
    fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  // A busy server (several builds at once) can drop a request; a read is safe to repeat.
  let response;
  for (let attempt = 1; !response; attempt++)
    try {
      response = await send();
    } catch (error) {
      if (method !== "GET" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (e.g. the root route); keep the text.
  }
  if (expectStatus !== undefined)
    assert.equal(
      response.status,
      expectStatus,
      `${method} ${path} returned ${response.status}: ${truncate(text)}`,
    );
  return { status: response.status, data };
};

/**
 * Calls a third-party API. Credentials travel in `query`/`headers` and are
 * never included in error messages (only origin + path are reported).
 */
const external = async (method, url, { query = {}, headers = {}, body } = {}) => {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) target.searchParams.set(key, String(value));
  const response = await fetch(target, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${target.origin}${target.pathname} returned ${response.status}: ${truncate(text, 300)}`);
  return text ? JSON.parse(text) : undefined;
};

/**
 * Polls `check` until it returns a value other than undefined. `check` may
 * throw to fail fast (e.g. on a terminal error state).
 */
const poll = async (describe, check, { timeoutMs, intervalMs = envInt("E2E_POLL_INTERVAL_MS", 5000) }) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await check((value) => (last = value));
    if (result !== undefined) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}; last seen: ${truncate(JSON.stringify(last))}`);
};

/** Fails with a clear message when the server is not up, instead of N fetch errors. */
const assertServerHealthy = async () => {
  let health;
  try {
    health = await api("GET", "/health");
  } catch (error) {
    throw new Error(`Server not reachable at ${baseUrl()} (${error.message}). Start it with \`npm run dev:local\`.`);
  }
  assert.equal(health.status, 200, `Server is degraded: ${JSON.stringify(health.data)}`);
};

/**
 * Sequential steps that share state: once one fails, the rest are skipped
 * rather than failing with confusing follow-on errors.
 */
const steps = () => {
  let failed = null;
  return (name, fn, options = {}) =>
    test(name, options, async (t) => {
      if (failed) {
        t.skip(`skipped because "${failed}" failed`);
        return;
      }
      try {
        await fn(t);
      } catch (error) {
        failed = name;
        throw error;
      }
    });
};

module.exports = {
  api,
  assertServerHealthy,
  env,
  envInt,
  external,
  poll,
  runId,
  skipUnless,
  steps,
};
