const assert = require("node:assert/strict");
const test = require("node:test");

const { createTrace, render } = require("../scripts/trace");

const at = "2026-11-15T01:40:13.000Z";
const step = (type, payload) => ({ type, payload, createdAt: at });

test("each step prints its reply, then its tool calls in full, matched in order within the attempt", () => {
  const toolCalls = [
    { id: "1", attemptId: "a1", name: "read_file", status: "COMPLETED", input: { path: "src/a.c" }, output: { text: "1\tint a;" } },
    { id: "2", attemptId: "a1", name: "edit_file", status: "COMPLETED", input: { path: "src/a.c", oldText: "int a;", newText: "int a = 0;" }, output: { text: "Edited src/a.c" } },
    { id: "3", attemptId: "a1", name: "run_command", status: "COMPLETED", input: { command: "make test" }, output: { text: "PASSED" } },
  ];
  const events = [
    step("GRAPH_AGENT_STEP", { attemptId: "a1", attemptNumber: 1, step: 1, text: "Reading the file.", toolCalls: [{ name: "read_file", input: "{}", output: "cut" }] }),
    step("GRAPH_AGENT_STEP", { attemptId: "a1", attemptNumber: 1, step: 2, text: "", toolCalls: [{ name: "edit_file" }, { name: "run_command" }] }),
  ];
  const text = render(createTrace(), { events, toolCalls });

  assert.ok(text.indexOf("Reading the file.") < text.indexOf("> read_file"), "the reply comes before the calls it made");
  assert.match(text, /1\tint a;/, "the full stored output, not the event's preview");
  assert.doesNotMatch(text, /cut/);
  assert.match(text, /✎ edit_file src\/a\.c\n {4}- int a;\n {4}\+ int a = 0;/, "an edit shows as removed and added lines");
  assert.match(text, /\$ make test\n {4}PASSED/);
  assert.doesNotMatch(text, /preview only/);
});

test("a call that is not stored in full is labelled a preview, and is never matched to another call", () => {
  const toolCalls = [{ id: "9", attemptId: "a1", name: "verdict", status: "COMPLETED", input: {}, output: { text: "ok" } }];
  const events = [
    // The planner runs before any attempt exists, so only the event's preview is kept.
    step("PLAN_STEP", { step: 1, toolCalls: [{ name: "search_code", input: '{"query":"x"}', status: "COMPLETED" }] }),
    // The next stored call of the attempt has another name: fall back to the preview.
    step("GRAPH_AGENT_STEP", { attemptId: "a1", step: 1, text: "", toolCalls: [{ name: "read_file", input: "{}", output: "head" }] }),
  ];
  const trace = createTrace();
  const text = render(trace, { events, toolCalls });

  assert.equal(text.match(/preview only/g).length, 2);
  assert.equal(trace.used.size, 0);
});

test("a call still running is announced once, and a step already printed is not printed again", () => {
  const trace = createTrace();
  const running = { id: "5", attemptId: "a1", name: "run_command", status: "REQUESTED", input: { command: "make" }, output: null };
  assert.match(render(trace, { events: [], toolCalls: [running] }), /… running run_command/);
  assert.equal(render(trace, { events: [], toolCalls: [running] }), "", "announced once");

  const done = { ...running, status: "COMPLETED", output: { text: "built" } };
  const finished = [step("GRAPH_AGENT_STEP", { attemptId: "a1", step: 1, text: "", toolCalls: [{ name: "run_command" }] })];
  assert.match(render(trace, { events: finished, toolCalls: [done] }), /\$ make\n {4}built/);
  assert.equal(render(trace, { events: [], toolCalls: [done] }), "", "later polls with no new events print nothing");
});

test("a recorded model call prints the new part of its request and its reply uncut, before the step that reports it", () => {
  const long = "x".repeat(2500);
  const call = (id, startedAt, inputMessages, reply, extra = {}) => ({
    id, try: 1, purpose: "agent.v2", operation: "chat", systemInstructions: "You work in a checked-out repository.",
    inputMessages, outputMessages: reply && [{ role: "assistant", content: reply, toolCalls: [{ name: "read_file" }], finishReason: "tool_use" }],
    durationMs: 812, startedAt, ...extra,
  });
  const first = [{ role: "user", content: "Fix the ticket." }];
  const second = [...first, { role: "assistant", content: "" }, { role: "tool", content: "file body" }, { role: "user", content: "Two steps left." }];
  const modelCalls = [
    call("c1", "2026-11-15T01:40:10.000", first, long),
    call("c2", "2026-11-15T01:40:11.000", second, null, { error: "HTTP 500: overloaded", errorType: "500" }),
  ];
  const events = [step("GRAPH_AGENT_STEP", { attemptId: "a1", step: 1, text: long.slice(0, 2000), toolCalls: [] })];
  events[0].createdAt = "2026-11-15T01:40:10.500";
  const text = render(createTrace(), { events, toolCalls: [], modelCalls });

  assert.ok(text.indexOf("⇢ model call agent.v2, 812 ms") < text.indexOf("--- agent"), "the call prints before its step");
  assert.match(text, /system │ You work in a checked-out repository\./);
  assert.match(text, /user │ Fix the ticket\./);
  assert.ok(text.includes(long), "the reply is printed uncut");
  assert.doesNotMatch(text, /reply cut at 2,000/, "the step's cut copy is not printed again");
  assert.equal(text.match(/system │/g).length, 1, "the system prompt prints once per purpose");
  assert.equal(text.match(/Fix the ticket/g).length, 1, "a later call shows only its new messages");
  assert.match(text, /user │ Two steps left\./);
  assert.doesNotMatch(text, /file body/, "tool results are shown by the tool calls, not repeated");
  assert.match(text, /⇠ FAILED \(500\): HTTP 500: overloaded/);
});
