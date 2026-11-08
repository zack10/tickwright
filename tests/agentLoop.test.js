const assert = require("node:assert/strict");
const test = require("node:test");

const { attemptAllowance, compactMessages, describeAttempt, runAgentLoop } = require("../dist/services/agentGraph/agentLoop");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renderExecutionPrompt } = require("../dist/prompts");
const { collectRepoContext } = require("../dist/services/agentGraph/repoContext");

/** A model that replies with the scripted turns in order and records each request. */
const scriptedModel = (turns, usage = { inputTokens: 100, outputTokens: 10 }) => {
  const requests = [];
  let index = 0;
  const generate = async (request) => {
    requests.push(structuredClone(request));
    const script = turns[Math.min(index++, turns.length - 1)];
    const toolCalls = (script.calls ?? []).map(([name, args], i) => ({ id: `c${index}-${i}`, name, arguments: args }));
    return {
      message: { role: "assistant", content: script.text ?? "", toolCalls },
      text: script.text ?? "",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage,
    };
  };
  return { generate, requests };
};

/** Tools that echo their input; finish behaves like the real tool. */
const fakeTools = () => {
  const ran = [];
  const runTool = async (call) => {
    ran.push(call.name);
    if (call.name === "finish") return { status: "COMPLETED", output: "Finished.", finish: call.arguments };
    if (call.name === "edit_file" && call.arguments.path === "package.json")
      return { status: "DENIED", output: "protected" };
    return { status: "COMPLETED", output: `${call.name} ok` };
  };
  return { runTool, ran };
};

const budget = (overrides = {}) => ({ maxSteps: 10, maxTokens: 100_000, deadline: Date.now() + 60_000, ...overrides });
const input = (overrides = {}) => ({ system: "sys", task: "Fix the bug", tools: [], budget: budget(), ...overrides });

test("runs tools, feeds results back and stops when the agent finishes", async () => {
  const model = scriptedModel([
    { calls: [["read_file", { path: "src/a.js" }]] },
    { calls: [["edit_file", { path: "src/a.js", oldText: "-", newText: "+" }], ["run_check", { script: "test" }]] },
    { calls: [["finish", { status: "done", summary: "Fixed the sign." }]] },
  ]);
  const tools = fakeTools();
  const steps = [];
  const result = await runAgentLoop(input(), { ...model, ...tools, onStep: async (step) => steps.push(step) });

  assert.equal(result.stopReason, "done");
  assert.equal(result.summary, "Fixed the sign.");
  assert.equal(result.steps, 3);
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 30 });
  assert.deepEqual(tools.ran, ["read_file", "edit_file", "run_check", "finish"]);

  // The third request carries the whole conversation: task, both turns and every result in order.
  const third = model.requests[2].messages;
  assert.deepEqual(third.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "tool"]);
  assert.equal(third[2].content, "read_file ok");
  assert.equal(third[5].toolCallId, "c2-1");
  assert.deepEqual(steps.map((s) => s.toolCalls.map((t) => t.call.name)), [["read_file"], ["edit_file", "run_check"], ["finish"]]);
});

test("a denied call is returned to the model as an error result", async () => {
  const model = scriptedModel([
    { calls: [["edit_file", { path: "package.json", oldText: "a", newText: "b" }]] },
    { calls: [["finish", { status: "done", summary: "ok" }]] },
  ]);
  await runAgentLoop(input(), { ...model, ...fakeTools() });
  const result = model.requests[1].messages[2];
  assert.equal(result.isError, true);
  assert.equal(result.content, "protected");
});

test("the agent can decline the ticket", async () => {
  const model = scriptedModel([{ calls: [["finish", { status: "blocked", summary: "Sends data to an unknown host." }]] }]);
  const result = await runAgentLoop(input(), { ...model, ...fakeTools() });
  assert.equal(result.stopReason, "blocked");
  assert.equal(result.summary, "Sends data to an unknown host.");
});

test("calls after finish in the same turn are not run", async () => {
  const model = scriptedModel([
    { calls: [["finish", { status: "done", summary: "ok" }], ["edit_file", { path: "x", oldText: "", newText: "y" }]] },
  ]);
  const tools = fakeTools();
  await runAgentLoop(input(), { ...model, ...tools });
  assert.deepEqual(tools.ran, ["finish"]);
});

test("the step budget ends the loop before another model call", async () => {
  const model = scriptedModel([{ calls: [["list_files", {}]] }]);
  const result = await runAgentLoop(input({ budget: budget({ maxSteps: 3 }) }), { ...model, ...fakeTools() });
  assert.equal(result.stopReason, "max_steps");
  assert.equal(result.steps, 3);
  assert.equal(model.requests.length, 3);
  assert.match(result.summary, /3 steps/);
});

test("the token budget counts input and output tokens", async () => {
  const model = scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 });
  const result = await runAgentLoop(input({ budget: budget({ maxTokens: 1200 }) }), { ...model, ...fakeTools() });
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(model.requests.length, 3, "500 + 500 is under budget, 1500 is not");
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 300 });
});

test("the agent is warned once when most of its budget is used", async () => {
  // 500 tokens a step against 2400: the warning threshold (1920) is passed at step 4.
  const model = scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 });
  let calls = 0;
  const runTool = async () => ({ status: "COMPLETED", output: `list ${++calls}` });
  const result = await runAgentLoop(input({ budget: budget({ maxTokens: 2400 }) }), { ...model, runTool });
  assert.equal(result.stopReason, "max_tokens");
  const results = model.requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.deepEqual(results.slice(0, 3), ["list 1", "list 2", "list 3"]);
  assert.match(results[3], /^list 4\n\n\[Budget: 4 of 10 steps and 2000 of 2400 tokens used\. .*call finish now/);
  assert.equal(results.length, 4);
});

test("a result identical to one still shown is replaced by a note, and repeats are flagged", async () => {
  const model = scriptedModel([
    { calls: [["read_file", { path: "a.js", startLine: 1 }]] },
    // Same call with its arguments in another order: still the same call.
    { calls: [["read_file", { startLine: 1, path: "a.js" }], ["read_file", { path: "b.js" }]] },
    { calls: [["read_file", { path: "a.js", startLine: 1 }]] },
    { calls: [["finish", { status: "done", summary: "ok" }]] },
  ]);
  const runTool = async (call) =>
    call.name === "finish"
      ? { status: "COMPLETED", output: "Finished.", finish: call.arguments }
      : { status: "COMPLETED", output: `contents of ${call.arguments.path}` };
  await runAgentLoop(input(), { ...model, runTool });

  const results = model.requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(results[0], "contents of a.js");
  assert.match(results[1], /^\[Same result as your identical read_file call at step 1, which is shown above/);
  assert.equal(results[2], "contents of b.js");
  assert.match(results[3], /at step 1.*\n\[You have made this exact call 3 times with the same result/);
});

test("a repeated call whose result changed, or whose earlier copy is shortened, gets the full output", async () => {
  let version = 1;
  const model = scriptedModel([
    { calls: [["read_file", { path: "a.js" }]] },
    { calls: [["edit_file", { path: "a.js" }]] },
    { calls: [["read_file", { path: "a.js" }]] },
    ...Array.from({ length: 14 }, (_, i) => ({ calls: [["read_file", { path: `other${i}.js` }]] })),
    { calls: [["read_file", { path: "a.js" }]] },
    { calls: [["finish", { status: "done", summary: "ok" }]] },
  ]);
  const runTool = async (call) => {
    if (call.name === "finish") return { status: "COMPLETED", output: "Finished.", finish: call.arguments };
    if (call.name === "edit_file") return { status: "COMPLETED", output: `edited to ${++version}` };
    return { status: "COMPLETED", output: `${call.arguments.path} v${version}\n${"x".repeat(500)}` };
  };
  await runAgentLoop(input({ budget: budget({ maxSteps: 20 }) }), { ...model, runTool });

  const results = model.requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[2], /^a\.js v2\n/, "the file changed, so it is shown again");
  // Fourteen other results later the step-3 copy is in a shortened batch (18 results, 8 shortened), so it is sent in full again.
  assert.match(results.at(-1), /^a\.js v2\nx{500}$/);
});

test("at its share, an attempt with changes is told to wrap up and can still finish", async () => {
  // 500 tokens a step: the 1000-token share is reached before step 3.
  const model = scriptedModel(
    [
      { calls: [["read_file", { path: "a.js" }]] },
      { calls: [["edit_file", { path: "a.js" }]] },
      { calls: [["run_check", { name: "test" }]] },
      { calls: [["finish", { status: "done", summary: "Fixed." }]] },
    ],
    { inputTokens: 400, outputTokens: 100 },
  );
  let asked = 0;
  const result = await runAgentLoop(
    input({ budget: budget({ soft: { maxTokens: 1000, deadline: Date.now() + 60_000 } }) }),
    { ...model, ...fakeTools(), hasChanges: async () => (++asked, true) },
  );
  assert.equal(result.stopReason, "done");
  assert.equal(result.steps, 4);
  assert.equal(asked, 1, "asked once, when the share is reached");
  const results = model.requests[2].messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results.at(-1), /^edit_file ok\n\n\[Budget: .*\]\n\n\[This attempt has used its share of the budget\. You have 3 more steps/);
});

test("at its share, an attempt with no changes stops", async () => {
  const model = scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 });
  const result = await runAgentLoop(
    input({ budget: budget({ soft: { maxTokens: 1000, deadline: Date.now() + 60_000 } }) }),
    { ...model, ...fakeTools(), hasChanges: async () => false },
  );
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(model.requests.length, 2);
  assert.match(result.summary, /this attempt's 1000 tokens/);
});

test("the wrap-up steps are limited, and the hard limit still applies during them", async () => {
  const model = scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 });
  const soft = { maxTokens: 1000, deadline: Date.now() + 60_000, graceSteps: 2 };
  const graceEnded = await runAgentLoop(input({ budget: budget({ soft }) }), {
    ...model,
    ...fakeTools(),
    hasChanges: async () => true,
  });
  assert.equal(graceEnded.stopReason, "max_tokens");
  assert.equal(graceEnded.steps, 4, "2 steps to the share, then 2 wrap-up steps");
  assert.match(graceEnded.summary, /The 2 wrap-up steps ended without finish/);

  const hard = await runAgentLoop(input({ budget: budget({ maxTokens: 1500, soft }) }), {
    ...scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 }),
    ...fakeTools(),
    hasChanges: async () => true,
  });
  assert.equal(hard.steps, 3, "the execution's budget ends the wrap-up early");
  assert.match(hard.summary, /of 1500 tokens/);
});

test("the soft time limit works like the token share", async () => {
  let clock = 0;
  const model = scriptedModel([{ calls: [["list_files", {}]] }]);
  const tools = fakeTools();
  const result = await runAgentLoop(
    input({ budget: budget({ deadline: 1000, soft: { maxTokens: 100_000, deadline: 100 } }) }),
    { ...model, runTool: async (call) => ((clock += 40), tools.runTool(call)), now: () => clock, hasChanges: async () => false },
  );
  assert.equal(result.stopReason, "timeout");
  assert.equal(model.requests.length, 3);
  assert.match(result.summary, /this attempt's share of the time budget/);
});

test("with a share, the budget warning is based on the share", async () => {
  const model = scriptedModel([{ calls: [["list_files", {}]] }], { inputTokens: 400, outputTokens: 100 });
  await runAgentLoop(input({ budget: budget({ soft: { maxTokens: 2400, deadline: Date.now() + 60_000 } }) }), {
    ...model,
    ...fakeTools(),
    hasChanges: async () => false,
  });
  const results = model.requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[3], /\[Budget: 4 of 10 steps and 2000 of 2400 tokens used/);
});

test("every attempt but the last gets a share of what is left", () => {
  assert.equal(attemptAllowance(180_000, 1, 3, 0.5), 90_000);
  // A first attempt that used 30k of its 90k leaves 150k: the second gets half of it.
  assert.equal(attemptAllowance(150_000, 2, 3, 0.5), 75_000);
  assert.equal(attemptAllowance(75_000, 3, 3, 0.5), 75_000, "the last attempt gets everything left");
  assert.equal(attemptAllowance(1000, 1, 1, 0.5), 1000, "a single attempt is also the last");
});

test("an attempt's account keeps its last steps when it is too long", () => {
  const step = (n, output) => ({
    step: n,
    text: n === 1 ? "Reading the module." : "",
    toolCalls: [{ call: { id: `c${n}`, name: "read_file", arguments: { path: `f${n}.js` } }, outcome: { status: "COMPLETED", output } }],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const short = describeAttempt([step(1, "one"), step(2, "two")]);
  assert.equal(short, 'Step 1: Reading the module.\n  read_file {"path":"f1.js"} -> COMPLETED: one\nStep 2:\n  read_file {"path":"f2.js"} -> COMPLETED: two');

  const long = describeAttempt(Array.from({ length: 20 }, (_, i) => step(i + 1, "y".repeat(1000))), 2000);
  assert.match(long, /^\(\d+ earlier steps left out\)\nStep \d+:/);
  assert.match(long, /Step 20:\n  read_file .* -> COMPLETED: y{400}… \(600 more characters\)$/);
  assert.ok(long.length < 2200);
});

test("the time budget is checked before each model call", async () => {
  let clock = 0;
  const model = scriptedModel([{ calls: [["list_files", {}]] }]);
  const tools = fakeTools();
  const runTool = async (call) => {
    clock += 40;
    return tools.runTool(call);
  };
  const result = await runAgentLoop(input({ budget: budget({ deadline: 100 }) }), {
    ...model,
    runTool,
    now: () => clock,
  });
  assert.equal(result.stopReason, "timeout");
  assert.equal(model.requests.length, 3, "calls start at t=0, 40 and 80; the one at 120 does not");
});

test("a reply without tool calls gets a reminder, then the loop gives up", async () => {
  const model = scriptedModel([{ text: "The fix is to change - to +." }]);
  const result = await runAgentLoop(input(), { ...model, ...fakeTools() });
  assert.equal(result.stopReason, "no_finish");
  assert.equal(model.requests.length, 3, "first reply plus two reminders");
  assert.match(model.requests[1].messages.at(-1).content, /call finish/);

  const recovered = scriptedModel([{ text: "Let me think." }, { calls: [["finish", { status: "done", summary: "ok" }]] }]);
  assert.equal((await runAgentLoop(input(), { ...recovered, ...fakeTools() })).stopReason, "done");
});

test("old tool output is shortened in batches; recent output and pairing are kept", () => {
  const long = (name) => `${name} header\n${"x".repeat(1000)}`;
  const conversation = (results) => {
    const messages = [{ role: "user", content: "task" }];
    for (let i = 0; i < results; i++) {
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read_file", arguments: {} }], raw: { provider: "p", content: [i] } });
      messages.push({ role: "tool", toolCallId: `t${i}`, name: "read_file", content: long(`file${i}`) });
    }
    return messages;
  };

  // keep 3: nothing is shortened until 6 results have built up.
  const five = conversation(5);
  assert.deepEqual(compactMessages(five, 3), five, "below two batches nothing changes");

  const six = conversation(6);
  six.push({ role: "tool", toolCallId: "short", name: "run_check", content: "short output" });
  const compacted = compactMessages(six, 3);
  assert.equal(compacted.length, six.length, "nothing is removed");
  assert.match(compacted[2].content, /^file0 header\n\[older read_file output removed/);
  assert.match(compacted[6].content, /removed/, "the oldest batch of three is shortened together");
  assert.equal(compacted[8].content, long("file3"), "the most recent results stay whole");
  assert.equal(compacted[13].content, "short output");
  assert.equal(compacted[2].toolCallId, "t0");
  assert.deepEqual(compacted[1].raw, { provider: "p", content: [0] }, "assistant turns keep their raw reply");
  assert.equal(six[2].content, long("file0"), "the input is not modified");

  // Until the next batch, earlier messages stay exactly the same, so a provider's prompt cache keeps matching.
  const at = (results) => compactMessages(conversation(results), 3);
  for (const results of [7, 8]) assert.deepEqual(at(results).slice(0, at(6).length), at(6), `unchanged at ${results} results`);
  assert.match(at(9)[8].content, /removed/, "the next batch is shortened at 9 results");
});

test("the agent prompt gets the environment and keeps ticket text out of the system prompt", () => {
  const prompt = renderExecutionPrompt("agent", {
    ticket: "Fix total\nRounding is off",
    environment: "Image: example/image:1\nChecks:\n- test: make test",
    internalPlan: "plan",
    repoOverview: "Repository file tree sample:\nsrc/a.js",
    lastFailure: "None",
  });
  assert.equal(prompt.version, "agent.v6");
  assert.match(prompt.user, /Repository overview:\nRepository file tree sample/);
  assert.match(prompt.user, /Repository environment:\nImage: example\/image:1\nChecks:\n- test: make test/);
  assert.match(prompt.system, /run_command/);
  assert.match(prompt.system, /status "blocked"/);
  assert.match(prompt.user, /Rounding is off/);
  assert.doesNotMatch(prompt.system, /Rounding is off/);
});

test("the repository overview lists relevant files without their contents", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-overview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/pagination.js"), "const SECRET_BODY = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), '{ "scripts": { "test": "node --test" } }');

  const context = await collectRepoContext(root, "paginate skips the first page in pagination.js", { language: "JavaScript/TypeScript (Node)", checks: { test: ["npm", "run", "test"] } });
  assert.match(context.summary, /SECRET_BODY/, "single-shot mode still gets the contents");
  assert.doesNotMatch(context.overview, /SECRET_BODY/);
  assert.match(context.overview, /Files that look relevant to the ticket: .*src\/pagination\.js/);
  assert.match(context.overview, /Checks: test/);
});

test("finalTools are the only tools offered on the last step and past the token warning", async () => {
  const read = { name: "read_file" };
  const verdict = { name: "verdict" };
  const byStep = scriptedModel([{ calls: [["read_file", { path: "a" }]] }]);
  const result = await runAgentLoop(
    input({ tools: [read, verdict], finalTools: [verdict], budget: budget({ maxSteps: 3 }) }),
    { ...byStep, ...fakeTools() },
  );
  assert.equal(result.stopReason, "max_steps");
  assert.deepEqual(byStep.requests.map((request) => request.tools.map((tool) => tool.name)), [
    ["read_file", "verdict"],
    ["read_file", "verdict"],
    ["verdict"],
  ]);

  // 110 tokens per call, 400 in all: after two calls (220) the third and a fourth would not both fit.
  const byTokens = scriptedModel([{ calls: [["read_file", { path: "a" }]] }]);
  await runAgentLoop(input({ tools: [read, verdict], finalTools: [verdict], budget: budget({ maxTokens: 400 }) }), {
    ...byTokens,
    ...fakeTools(),
  });
  assert.deepEqual(byTokens.requests.map((request) => request.tools.length), [2, 2, 1, 1]);
});

test("steps that grow (large file reads) still reach a final step before the budget runs out", async () => {
  const read = { name: "read_file" };
  const verdict = { name: "verdict" };
  // 5k, 10k, 15k, 20k tokens: after three calls 30k of 40k is used, under the 80% warning,
  // and the fourth call would end the loop over budget without a verdict.
  const model = scriptedModel([{ calls: [["read_file", { path: "big" }]] }]);
  let call = 0;
  const generate = async (request) => ({ ...(await model.generate(request)), usage: { inputTokens: 5000 * ++call, outputTokens: 0 } });
  await runAgentLoop(input({ tools: [read, verdict], finalTools: [verdict], budget: budget({ maxTokens: 40_000 }) }), {
    generate,
    ...fakeTools(),
  });
  assert.deepEqual(model.requests.map((request) => request.tools.length), [2, 2, 2, 1]);
});

test("keepRecentResults keeps more tool results in full", async () => {
  const long = "x".repeat(1000);
  const model = scriptedModel([...Array.from({ length: 12 }, (_, i) => ({ calls: [["read_file", { path: `f${i}` }]] })), { calls: [["finish", { status: "done", summary: "s" }]] }]);
  await runAgentLoop(input({ keepRecentResults: 20, budget: budget({ maxSteps: 20 }) }), {
    ...model,
    runTool: async (call) => (call.name === "finish" ? { status: "COMPLETED", output: "", finish: call.arguments } : { status: "COMPLETED", output: long }),
  });
  const last = model.requests[model.requests.length - 1].messages.filter((message) => message.role === "tool");
  assert.equal(last.length, 12);
  assert.ok(last.every((message) => message.content === long), "nothing shortened");
});
