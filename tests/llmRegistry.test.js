const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

const { ProviderRegistry, parseProviderProfiles } = require("../dist/services/llm/registry");
const { LLMService } = require("../dist/services/llm/LLMService");
const { createAgentSchema } = require("../dist/schemas");

const env = { GROQ_API_KEY: "groq-key", MISTRAL_API_KEY: "mistral-key" };
const groq = { key: "groq", baseUrl: "https://api.groq.com/openai/v1/", apiKeyEnv: "GROQ_API_KEY", supportsTools: true };
const mistral = { key: "mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" };

const parse = (profiles, nodeEnv = "development", vars = env) =>
  parseProviderProfiles(JSON.stringify(profiles), vars, nodeEnv);

/** Replaces axios.post for one test and records every request. */
const capturePosts = (t) => {
  const calls = [];
  const original = axios.post;
  axios.post = async (url, body, options) => {
    calls.push({ url, body, headers: options.headers });
    return { data: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } };
  };
  t.after(() => {
    axios.post = original;
  });
  return calls;
};

test("without LLM_PROVIDERS only the built-in OpenAI profile exists, honouring OPENAI_BASE_URL", () => {
  const profiles = parseProviderProfiles("", { OPENAI_BASE_URL: "https://proxy.example.com/v1/", OPENAI_API_KEY: "k" }, "development");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].key, "openai");
  assert.equal(profiles[0].baseUrl, "https://proxy.example.com/v1");
  assert.equal(profiles[0].apiKey, "k");
});

test("profiles are parsed with their keys, trimmed URLs and capabilities", () => {
  const [, first, second] = parse([groq, mistral]);
  assert.deepEqual(
    { key: first.key, baseUrl: first.baseUrl, apiKey: first.apiKey, supportsTools: first.supportsTools },
    { key: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "groq-key", supportsTools: true },
  );
  assert.equal(second.supportsTools, false, "tool support must be declared, not assumed");
  assert.equal(second.label, "mistral");
});

test("invalid profiles refuse to load", () => {
  const rejects = (profiles, pattern, nodeEnv, vars) => assert.throws(() => parse(profiles, nodeEnv, vars), pattern);
  assert.throws(() => parseProviderProfiles("{not json", env, "development"), /JSON array/);
  rejects([groq, groq], /already in use/);
  rejects([{ ...groq, key: "gemini" }], /already in use/);
  rejects([{ ...groq, key: "openai" }], /already in use/);
  rejects([{ ...groq, key: "Bad Key" }], /key must be/);
  rejects([{ ...groq, baseUrl: "http://api.groq.com/v1" }], /https/);
  rejects([{ ...groq, baseUrl: "ftp://api.groq.com/v1" }], /https/);
  rejects([{ ...groq, baseUrl: "https://user:pass@api.groq.com/v1" }], /credentials/);
  rejects([{ ...groq, baseUrl: "https://api.groq.com/v1?key=x" }], /query/);
  rejects([{ ...groq, apiKeyEnv: "UNSET_KEY" }], /UNSET_KEY is not set/);
  rejects([{ ...groq, extra: true }], /Unrecognized key/);
});

test("http is allowed only for localhost, and never in production", () => {
  const ollama = { key: "ollama", baseUrl: "http://localhost:11434/v1" };
  assert.equal(parse([ollama])[1].baseUrl, "http://localhost:11434/v1");
  assert.equal(parse([ollama])[1].apiKey, "", "a keyless local server gets no key");
  assert.throws(() => parse([ollama], "production"), /not allowed in production/);
});

test("the default provider must be configured", () => {
  assert.throws(() => new ProviderRegistry(parse([]), "groq", "llama"), /not a configured provider/);
  const registry = new ProviderRegistry(parse([groq]), "groq", "llama-3.3-70b");
  assert.deepEqual(
    registry.list().map((provider) => [provider.key, provider.kind]),
    [
      ["gemini", "native"],
      ["anthropic", "native"],
      ["openai", "openai-compatible"],
      ["groq", "openai-compatible"],
    ],
  );
});

test("two profiles route to their own base URLs and keys; an agent key wins over the profile's", async (t) => {
  const calls = capturePosts(t);
  const llm = new LLMService(new ProviderRegistry(parse([groq, mistral]), "gemini", "gemini-flash-latest"), null);

  assert.equal(await llm.generateContent("groq", "llama", { system: "sys", user: "hi" }), "ok");
  await llm.generateContent("mistral", "mistral-small", { user: "hi" });
  await llm.generateContent("mistral", "mistral-small", { user: "hi" }, "agent-key");

  assert.deepEqual(
    calls.map((call) => [call.url, call.headers.Authorization]),
    [
      ["https://api.groq.com/openai/v1/chat/completions", "Bearer groq-key"],
      ["https://api.mistral.ai/v1/chat/completions", "Bearer mistral-key"],
      ["https://api.mistral.ai/v1/chat/completions", "Bearer agent-key"],
    ],
  );
  assert.deepEqual(calls[0].body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("a keyless profile sends no Authorization header", async (t) => {
  const calls = capturePosts(t);
  const llm = new LLMService(
    new ProviderRegistry(parse([{ key: "ollama", baseUrl: "http://localhost:11434/v1" }]), "ollama", "llama3"),
    null,
  );
  await llm.generateContent("ollama", "llama3", { user: "hi" });
  assert.equal(calls[0].headers.Authorization, undefined);
});

test("resolveModel applies the default provider and model, and rejects incomplete agents", () => {
  const llm = new LLMService(new ProviderRegistry(parse([groq]), "groq", "llama-3.3-70b"), null);
  assert.deepEqual(llm.resolveModel({}), { provider: "groq", model: "llama-3.3-70b" });
  assert.deepEqual(llm.resolveModel({ provider: "openai", model: "gpt-4o" }), { provider: "openai", model: "gpt-4o" });
  assert.throws(() => llm.resolveModel({ provider: "openai" }), /has no model set/);
  assert.throws(() => llm.resolveModel({ provider: "removed", model: "x" }), /not configured/);
});

test("agent validation accepts registered providers only", () => {
  const body = (provider) => ({ body: { name: "a", provider } });
  assert.equal(createAgentSchema.safeParse(body("anthropic")).success, true);
  assert.equal(createAgentSchema.safeParse(body("openai")).success, true);
  const rejected = createAgentSchema.safeParse(body("made-up"));
  assert.equal(rejected.success, false);
  assert.match(rejected.error.issues[0].message, /Unknown LLM provider/);
});

test("agent config.reasoningEffort accepts known call kinds and levels only", () => {
  const body = (reasoningEffort) => ({ body: { name: "a", config: { reasoningEffort } } });
  assert.equal(createAgentSchema.safeParse(body({ triage: "low", plan: "low", reviewer: "high" })).success, true);
  assert.equal(createAgentSchema.safeParse(body({ triage: "minimal" })).success, false);
  assert.equal(createAgentSchema.safeParse(body({ triag: "low" })).success, false, "a typo is refused, not ignored");
});

test("the built-in OpenAI profile calls tools through the Responses API unless OPENAI_TOOLS_API says chat", () => {
  assert.equal(parseProviderProfiles("", {}, "development")[0].toolsApi, "responses");
  assert.equal(parseProviderProfiles("", { OPENAI_TOOLS_API: "chat" }, "development")[0].toolsApi, "chat");
  assert.throws(() => parseProviderProfiles("", { OPENAI_TOOLS_API: "soap" }, "development"), /OPENAI_TOOLS_API/);
  assert.equal(parse([groq])[1].toolsApi, "chat", "other vendors default to chat completions");
  assert.equal(parse([{ ...groq, toolsApi: "responses" }])[1].toolsApi, "responses");
  assert.throws(() => parse([{ ...groq, toolsApi: "soap" }]), /toolsApi/);
});

test("agent validation checks config.reviewer and keeps other config as is", () => {
  const body = (config) => ({ body: { name: "a", config } });
  assert.equal(createAgentSchema.safeParse(body({ reviewer: { provider: "openai", model: "gpt-5" }, other: 1 })).success, true);
  assert.equal(createAgentSchema.safeParse(body({ reviewer: { provider: "made-up", model: "x" } })).success, false);
  assert.equal(createAgentSchema.safeParse(body({ reviewer: { provider: "openai" } })).success, false, "a model is required");
  assert.equal(createAgentSchema.safeParse(body({ reviewer: { provider: "openai", model: "m", extra: 1 } })).success, false);

  const nano = { provider: "openai", model: "gpt-5-nano" };
  assert.equal(createAgentSchema.safeParse(body({ models: { triage: nano, plan: nano, analyze: nano } })).success, true);
  assert.equal(createAgentSchema.safeParse(body({ models: { triag: nano } })).success, false, "a typo is refused, not ignored");
  assert.equal(createAgentSchema.safeParse(body({ models: { plan: { provider: "made-up", model: "x" } } })).success, false);
});
