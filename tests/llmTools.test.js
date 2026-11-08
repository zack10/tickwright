const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

const { ProviderRegistry, parseProviderProfiles } = require("../dist/services/llm/registry");
const { LLMService } = require("../dist/services/llm/LLMService");

// The same tool and conversation run through every provider.
const readFile = {
  name: "read_file",
  description: "Read a file from the repository",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Relative path" } },
    required: ["path"],
  },
};
const ask = { role: "user", content: "What does src/a.js export?" };

const registry = new ProviderRegistry(
  parseProviderProfiles(
    JSON.stringify([
      { key: "local", baseUrl: "http://localhost:11434/v1" },
      { key: "groq", baseUrl: "https://api.groq.com/openai/v1", supportsTools: true },
    ]),
    {},
    "development",
  ),
  "gemini",
  "gemini-flash-latest",
);
// No usage ledger: these tests are about request and reply mapping.
const llm = new LLMService(registry, null);

/** Answers axios.post with `replies` in order and records each request body. */
const scripted = (t, replies) => {
  const bodies = [];
  const original = axios.post;
  axios.post = async (url, body) => {
    bodies.push({ url, body });
    return { data: replies[bodies.length - 1] };
  };
  t.after(() => {
    axios.post = original;
  });
  return bodies;
};

/** Turn 1 asks for the tool, turn 2 answers; returns both turns. */
const roundTrip = async (provider, model) => {
  const request = { system: "Be brief.", messages: [ask], tools: [readFile] };
  const first = await llm.generateWithTools(provider, model, request);
  const second = await llm.generateWithTools(provider, model, {
    ...request,
    messages: [
      ask,
      first.message,
      { role: "tool", toolCallId: first.toolCalls[0].id, name: "read_file", content: "module.exports = { a };" },
    ],
  });
  return { first, second };
};

const expectSameOutcome = ({ first, second }, toolCallId) => {
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(first.toolCalls, [{ id: toolCallId, name: "read_file", arguments: { path: "src/a.js" } }]);
  assert.equal(second.stopReason, "end_turn");
  assert.deepEqual(second.toolCalls, []);
  assert.equal(second.text, "It exports a.");
};

test("Anthropic: tool_use round trip, with thinking blocks replayed unchanged", async (t) => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-123" };
  const bodies = scripted(t, [
    {
      stop_reason: "tool_use",
      content: [thinking, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.js" } }],
      usage: { input_tokens: 20, cache_read_input_tokens: 90, cache_creation_input_tokens: 10, output_tokens: 30 },
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "It exports a." }], usage: { input_tokens: 160, output_tokens: 8 } },
  ]);
  const turns = await roundTrip("anthropic", "claude-haiku-5-5");
  expectSameOutcome(turns, "toolu_1");
  assert.deepEqual(turns.first.usage, { inputTokens: 120, outputTokens: 30, cachedInputTokens: 90 }, "cache reads and writes count as input");

  const [request1, request2] = bodies.map((entry) => entry.body);
  assert.equal(bodies[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(request1.system, "Be brief.");
  assert.deepEqual(request1.tools, [
    { name: "read_file", description: readFile.description, input_schema: readFile.parameters },
  ]);
  assert.deepEqual(request2.messages[1], {
    role: "assistant",
    content: [thinking, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.js" } }],
  });
  // The last block is marked for Anthropic's prompt cache; earlier messages are sent unchanged.
  const cache = { type: "ephemeral" };
  assert.deepEqual(request1.messages[0], { role: "user", content: [{ type: "text", text: ask.content, cache_control: cache }] });
  assert.deepEqual(request2.messages[0], { role: "user", content: ask.content });
  assert.deepEqual(request2.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "module.exports = { a };", cache_control: cache }],
  });
});

test("Gemini: functionCall round trip, with thought signatures replayed unchanged", async (t) => {
  const callPart = { functionCall: { name: "read_file", args: { path: "src/a.js" } }, thoughtSignature: "sig-456" };
  const bodies = scripted(t, [
    {
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [callPart] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 15, cachedContentTokenCount: 40 },
    },
    { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "It exports a." }] } }] },
  ]);
  const turns = await roundTrip("gemini", "gemini-flash-latest");
  expectSameOutcome(turns, "call-0");
  assert.deepEqual(turns.first.usage, { inputTokens: 100, outputTokens: 35, cachedInputTokens: 40, reasoningTokens: 15 }, "thinking tokens count as output");

  const [request1, request2] = bodies.map((entry) => entry.body);
  assert.deepEqual(request1.system_instruction, { parts: [{ text: "Be brief." }] });
  assert.deepEqual(request1.tools, [
    { functionDeclarations: [{ name: "read_file", description: readFile.description, parameters: readFile.parameters }] },
  ]);
  assert.deepEqual(request2.contents[1], { role: "model", parts: [callPart] });
  assert.deepEqual(request2.contents[2], {
    role: "user",
    parts: [{ functionResponse: { name: "read_file", response: { result: "module.exports = { a };" } } }],
  });
});

test("OpenAI-compatible chat completions: tool_calls round trip", async (t) => {
  const bodies = scripted(t, [
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.js"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 5 } },
    },
    { choices: [{ finish_reason: "stop", message: { content: "It exports a." } }] },
  ]);
  const turns = await roundTrip("groq", "llama-3.3-70b");
  expectSameOutcome(turns, "call_9");
  assert.deepEqual(turns.first.usage, { inputTokens: 90, outputTokens: 12, cachedInputTokens: 64, reasoningTokens: 5 });

  const [request1, request2] = bodies.map((entry) => entry.body);
  assert.deepEqual(request1.messages[0], { role: "system", content: "Be brief." });
  assert.deepEqual(request1.tools, [
    { type: "function", function: { name: "read_file", description: readFile.description, parameters: readFile.parameters } },
  ]);
  assert.deepEqual(request2.messages.slice(2), [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.js"}' } }],
    },
    { role: "tool", tool_call_id: "call_9", content: "module.exports = { a };" },
  ]);
});

test("OpenAI Responses API: function_call round trip, with reasoning items replayed unchanged", async (t) => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-789" };
  const call = { type: "function_call", id: "fc_1", call_id: "call_7", name: "read_file", arguments: '{"path":"src/a.js"}' };
  const bodies = scripted(t, [
    { status: "completed", output: [reasoning, call], usage: { input_tokens: 80, output_tokens: 25 } },
    {
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "It exports a." }] }],
    },
  ]);
  const turns = await roundTrip("openai", "gpt-6-luna");
  expectSameOutcome(turns, "call_7");
  assert.deepEqual(turns.first.usage, { inputTokens: 80, outputTokens: 25 });

  const [request1, request2] = bodies.map((entry) => entry.body);
  assert.equal(bodies[0].url, "https://api.openai.com/v1/responses");
  assert.equal(request1.instructions, "Be brief.");
  assert.equal(request1.store, false, "nothing is kept on OpenAI's side");
  assert.deepEqual(request1.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(request1.tools, [
    { type: "function", name: "read_file", description: readFile.description, parameters: readFile.parameters },
  ]);
  assert.deepEqual(request1.input, [ask]);
  assert.deepEqual(request2.input.slice(1), [
    reasoning,
    call,
    { type: "function_call_output", call_id: "call_7", output: "module.exports = { a };" },
  ]);
});

test("OpenAI Responses API: a turn from another provider is sent as plain items; incomplete replies raise", async (t) => {
  const bodies = scripted(t, [
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] },
    { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
    { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
  ]);
  const foreign = {
    role: "assistant",
    content: "Looking.",
    toolCalls: [{ id: "toolu_1", name: "read_file", arguments: { path: "a" } }],
    raw: { provider: "anthropic", content: [{ type: "thinking", signature: "s" }] },
  };
  await llm.generateWithTools("openai", "m", {
    messages: [ask, foreign, { role: "tool", toolCallId: "toolu_1", name: "read_file", content: "A", isError: true }],
    tools: [readFile],
  });
  assert.deepEqual(bodies[0].body.input.slice(1), [
    { role: "assistant", content: "Looking." },
    { type: "function_call", call_id: "toolu_1", name: "read_file", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "toolu_1", output: "Error: A" },
  ]);
  const request = { messages: [ask], tools: [readFile] };
  await assert.rejects(llm.generateWithTools("openai", "m", request), /truncated/);
  await assert.rejects(llm.generateWithTools("openai", "m", request), /content filter/);
});

test("reasoning effort is sent to OpenAI-compatible APIs only when set", async (t) => {
  const reply = { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
  const bodies = scripted(t, [reply, reply, reply]);
  await llm.generateContent("groq", "m", { user: "hi", reasoningEffort: "low" });
  await llm.generateWithTools("groq", "m", { messages: [ask], tools: [readFile], reasoningEffort: "high" });
  await llm.generateContent("groq", "m", { user: "hi" });
  assert.deepEqual(bodies.map((entry) => entry.body.reasoning_effort), ["low", "high", undefined]);
  assert.equal("reasoning_effort" in bodies[2].body, false, "models without reasoning reject the parameter");
});

test("several results for one turn travel together; errors are marked", async (t) => {
  const bodies = scripted(t, [{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
  await llm.generateWithTools("anthropic", "claude-haiku-5-5", {
    messages: [
      ask,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: { path: "a" } },
          { id: "t2", name: "read_file", arguments: { path: "b" } },
        ],
      },
      { role: "tool", toolCallId: "t1", name: "read_file", content: "A" },
      { role: "tool", toolCallId: "t2", name: "read_file", content: "no such file", isError: true },
    ],
    tools: [readFile],
  });
  const messages = bodies[0].body.messages;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[2].content, [
    { type: "tool_result", tool_use_id: "t1", content: "A" },
    { type: "tool_result", tool_use_id: "t2", content: "no such file", is_error: true, cache_control: { type: "ephemeral" } },
  ]);
});

test("unusable replies raise errors instead of being guessed at", async (t) => {
  scripted(t, [
    { stop_reason: "max_tokens", content: [] },
    { stop_reason: "refusal", content: [] },
    { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", content: { parts: [] } }] },
    { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c", function: { name: "read_file", arguments: "{oops" } }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "" } }] },
  ]);
  const request = { messages: [ask], tools: [readFile] };
  await assert.rejects(llm.generateWithTools("anthropic", "m", request), /truncated/);
  await assert.rejects(llm.generateWithTools("anthropic", "m", request), /refused/);
  await assert.rejects(llm.generateWithTools("gemini", "m", request), /MALFORMED_FUNCTION_CALL/);
  await assert.rejects(llm.generateWithTools("groq", "m", request), /invalid JSON arguments/);
  await assert.rejects(llm.generateWithTools("groq", "m", request), /empty response/);
});

test("a profile without supportsTools is refused before any request is sent", async (t) => {
  const bodies = scripted(t, []);
  await assert.rejects(
    llm.generateWithTools("local", "llama3", { messages: [ask], tools: [readFile] }),
    (error) => error.name === "NonRetryableError" && /does not support tool calling/.test(error.message),
  );
  assert.equal(bodies.length, 0);
});
