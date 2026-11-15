// Prints what one execution did, step by step: plan, each model reply with
// the tool calls it made (inputs and outputs in full), edits as diffs,
// review, verification. Read-only; reads the database through `docker exec`
// into its Postgres container, because the production stack exposes no
// database port.
//
//   npm run trace                     executions in progress
//   npm run trace -- <execution id>   the whole execution
//   npm run trace -- <id> --follow    and keep printing until it ends
//
// TRACE_DB_CONTAINER picks the Postgres container (default: the production stack's).
const { spawn } = require("node:child_process");

const CONTAINER = process.env.TRACE_DB_CONTAINER || "agent-orchestration-prod-postgres-1";
const ENDED = new Set(["COMPLETED", "BLOCKED", "FAILED", "CANCELED"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 3000;

/** Runs SQL whose rows are one JSON value each; streamed, since one execution's tool calls exceed exec's 1 MB buffer. */
const query = (sql) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", CONTAINER, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1']);
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) return reject(new Error(`psql in ${CONTAINER} failed: ${Buffer.concat(err).toString().trim()}`));
      resolve(Buffer.concat(out).toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)));
    });
    child.stdin.end(sql);
  });

const rows = (select) => `select row_to_json(x) from (${select}) x;`;

const load = async (id, afterSequence) => {
  const [execution] = await query(rows(`
    select e.id, e.status, e."createdAt", e."lastError", w.title, r.owner || '/' || r.name as repository
    from "Execution" e join "WorkItem" w on w.id = e."workItemId" join "Repository" r on r.id = e."repositoryId"
    where e.id = '${id}'`));
  if (!execution) throw new Error(`no execution ${id}`);
  // Through the plan: an attempt has no execution id, and time windows mix executions that run at once.
  const ofExecution = `join "PlanTask" pt on pt.id = a."planTaskId" join "Plan" p on p.id = pt."planId" where p."executionId" = '${id}'`;
  const [events, toolCalls, attempts] = await Promise.all([
    query(rows(`select sequence, type, payload, "createdAt" from "ExecutionEvent" where "executionId" = '${id}' and sequence > ${afterSequence} order by sequence`)),
    query(rows(`select t.id, t."attemptId", t.name, t.status, t.input, t.output from "ToolCall" t join "TaskAttempt" a on a.id = t."attemptId" ${ofExecution} order by t."createdAt", t.id`)),
    query(rows(`select a.id, a.number, a.status, a.error from "TaskAttempt" a ${ofExecution}`)),
  ]);
  return { execution, events, toolCalls, attempts };
};

const indent = (text, prefix = "    ") => String(text ?? "").replace(/\r/g, "").split("\n").map((line) => prefix + line).join("\n");
const tokens = (usage) => (usage ? ` (${usage.inputTokens} in, ${usage.outputTokens} out)` : "");
const time = (iso) => String(iso).slice(11, 19);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** One tool call: the command, edit or arguments, then what came back. */
const renderCall = (call, full) => {
  const input = typeof call.input === "string" ? parse(call.input) : call.input;
  const status = call.status === "COMPLETED" ? "" : `  [${call.status}]`;
  const lines = [];
  if (call.name === "run_command" && input?.command) lines.push(`  $ ${input.command}${status}`);
  else if (call.name === "edit_file" && input?.path) {
    lines.push(`  ✎ edit_file ${input.path}${status}`);
    if (input.oldText) lines.push(indent(input.oldText, "    - "));
    if (input.newText !== undefined) lines.push(indent(input.newText, "    + "));
  } else lines.push(`  > ${call.name} ${typeof input === "string" ? input : JSON.stringify(input)}${status}`);
  const output = typeof call.output === "string" ? call.output : call.output?.text;
  if (output !== undefined && output !== "") lines.push(indent(output));
  if (!full) lines.push("    [preview only: the full call is not stored]");
  return lines.join("\n");
};

const FORMAT = {
  EXECUTION_CREATED: () => "execution created",
  GRAPH_TICKET_TRIAGED: (p) => `triage: ${p.decision}\n${indent(p.reason)}`,
  PLAN_WRITTEN: (p) => `plan v${p.version} written; checks: ${(p.checks ?? []).join(", ") || "none"}; verification: ${p.verification}`,
  PLAN_APPROVED: (p) => `plan approved by ${p.actor}`,
  PUBLISH_REJECTED: (p) => `publish rejected by ${p.actor}: ${p.comment ?? ""}`,
  GRAPH_INTERNAL_PLAN_CREATED: (p) => `plan the run follows (v${p.planVersion}):\n${indent(p.internalPlan)}`,
  GRAPH_TOOLCHAIN_RESOLVED: (p) => `environment from ${p.source}: image ${p.image}; checks: ${(p.checks ?? []).join(", ")}${p.reason ? `\n${indent(p.reason)}` : ""}`,
  GRAPH_BASELINE_CHECKED: (p) => `baseline checks: ${(p.results ?? []).map((r) => `${r.check} ${r.passed ? "passed" : "FAILED"}`).join(", ")}`,
  GRAPH_STEP_PROGRESS: (p) => `still running: ${p.step}${p.check ? ` ${p.check}` : ""}, ${p.elapsedSeconds}s${p.possiblyHung ? " (possibly hung)" : ""}\n${indent(p.output)}`,
  GRAPH_AGENT_FINISHED: (p) => `agent stopped: ${p.stopReason} after ${p.steps} steps, ${p.tokensUsed} tokens\n${indent(p.summary)}`,
  GRAPH_POLICY_PASSED: (p) => `policy passed; files: ${(p.files ?? []).join(", ")}`,
  GRAPH_DIFF_REVIEW_PASSED: (p) => `review PASSED\n${indent(p.summary)}`,
  GRAPH_DIFF_REVIEW_FAILED: (p) => `review FAILED${p.handedToApprover ? " (handed to the approver)" : ""}\n${indent((p.issues ?? []).join("\n"))}`,
  GRAPH_FAILURE_ANALYZED: (p) => `failure analysis for the next attempt:\n${indent(p.guidance)}`,
  GRAPH_VERIFICATION_PASSED: (p) => `verification PASSED (${Array.isArray(p.checksRun) ? p.checksRun.join(", ") : `${p.checksRun} checks run`})`,
  GRAPH_DIFF_ARTIFACT_CREATED: (p) => `diff stored (sha256 ${String(p.sha256).slice(0, 12)})`,
};

/** State kept across calls of render, so --follow prints each step once. */
const createTrace = () => ({ used: new Set(), announced: new Set() });

/**
 * Turns events (in sequence order) and the execution's tool calls into text.
 * A step event is written after its tool calls ran, so each step prints its
 * reply first and then its calls, matched in order within the attempt; a
 * call whose name does not line up falls back to the event's preview.
 */
const render = (trace, { events, toolCalls, attempts = [] }) => {
  const out = [];
  const attemptNumber = new Map(attempts.map((a) => [a.id, a.number]));
  const nextCall = (attemptId, name) => {
    const row = toolCalls.find((call) => call.attemptId === attemptId && !trace.used.has(call.id));
    if (!row || row.name !== name) return undefined;
    trace.used.add(row.id);
    return row;
  };
  for (const { type, payload: p, createdAt } of events) {
    const at = `[${time(createdAt)}]`;
    if (type === "GRAPH_ATTEMPT_STARTED") {
      out.push(`\n${at} ===== attempt ${p.attemptNumber} started (prompts: ${JSON.stringify(p.promptVersions ?? {})})`);
    } else if (type === "PLAN_STEP" || type === "GRAPH_AGENT_STEP" || type === "GRAPH_REVIEW_STEP") {
      const who = type === "PLAN_STEP" ? "planner" : type === "GRAPH_REVIEW_STEP" ? "reviewer" : `agent, attempt ${p.attemptNumber ?? attemptNumber.get(p.attemptId) ?? "?"}`;
      out.push(`\n${at} --- ${who}, step ${p.step}${tokens(p.usage)}`);
      if (p.text) out.push(indent(p.text, "  │ ") + (p.text.length >= 2000 ? "\n  │ [reply cut at 2,000 characters in the stored event]" : ""));
      for (const preview of p.toolCalls ?? []) {
        const row = p.attemptId ? nextCall(p.attemptId, preview.name) : undefined;
        out.push(renderCall(row ?? preview, Boolean(row)));
      }
    } else if (type === "GRAPH_VERIFICATION_FAILED") {
      const attempt = attempts.find((a) => a.id === p.attemptId);
      // The stored error is check results as JSON text, cut short, so it cannot be parsed: unescape its line breaks.
      out.push(`${at} verification FAILED (attempt ${p.attemptNumber})${attempt?.error ? `\n${indent(attempt.error.replace(/\\n/g, "\n"))}` : ""}`);
    } else if (type === "GRAPH_BLOCKED") {
      out.push(`${at} BLOCKED after ${JSON.stringify(p.attempts)}`);
    } else {
      out.push(`${at} ${FORMAT[type] ? FORMAT[type](p) : `${type} ${JSON.stringify(p)}`}`);
    }
  }
  // Calls still running have no step event yet; say so once.
  for (const call of toolCalls) {
    if (call.status !== "REQUESTED" || trace.used.has(call.id) || trace.announced.has(call.id)) continue;
    trace.announced.add(call.id);
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input);
    out.push(`  … running ${call.name} ${input}`);
  }
  return out.join("\n");
};

const listInProgress = async () => {
  const list = await query(rows(`
    select e.id, e.status, e."createdAt", w.title from "Execution" e join "WorkItem" w on w.id = e."workItemId"
    where e.status not in ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELED') order by e."createdAt"`));
  if (!list.length) return console.log("No execution in progress. Pass an execution id to see a finished one.");
  for (const e of list) console.log(`${e.id}  ${e.status.padEnd(26)} ${time(e.createdAt)}  ${e.title}`);
};

const main = async () => {
  const id = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const follow = process.argv.includes("--follow");
  if (!id) return listInProgress();
  if (!UUID.test(id)) throw new Error(`not an execution id: ${id}`);
  const trace = createTrace();
  let after = 0;
  let header = false;
  for (;;) {
    const data = await load(id, after);
    if (!header) {
      console.log(`Execution ${id}\nTicket: ${data.execution.title}\nRepository: ${data.execution.repository}`);
      header = true;
    }
    const text = render(trace, data);
    if (text) console.log(text);
    after = data.events.at(-1)?.sequence ?? after;
    if (!follow || ENDED.has(data.execution.status)) {
      console.log(`\nStatus: ${data.execution.status}${data.execution.lastError ? `\n${indent(data.execution.lastError)}` : ""}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { createTrace, render, renderCall };
