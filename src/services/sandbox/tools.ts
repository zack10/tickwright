import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../../config";
import { findSymlink, isGitPath, resolveInsideRoot } from "../../utils/safePath";
import { isProtectedPath } from "../agentGraph/repoPolicy";
import { ToolDefinition } from "../llm/types";
import { SandboxResult } from "../workspaceService";

/**
 * Tools the agent uses inside a run's workspace. Every safety rule is
 * enforced here, in the tool, whatever the prompt or a skill says. A denied
 * or failed call is returned to the model as a result it can act on; only
 * bugs in this module throw.
 */

export interface ToolContext {
  /** Host path of the run's workspace (bind-mounted into the sandbox). */
  root: string;
  protectedPaths: string[];
  /** Checks run_check may run, by name: the repository toolchain's checks. */
  checkScripts: string[];
  /** Runs the named check's command in the run's sandbox. */
  runCheck: (check: string) => Promise<SandboxResult>;
  /** Runs a shell command in the run's sandbox (no network). */
  runCommand: (command: string, timeoutMs: number) => Promise<SandboxResult>;
  /** Whether a repository-relative path is a test file, per the toolchain. */
  isTestFile: (file: string) => boolean;
  /** Whether a file is tracked at the base commit; new files are not "existing" tests. */
  isBaseFile: (file: string) => boolean;
  /** Whether the problem was shown before code changed; updated by the tools. */
  reproduction: Reproduction;
  /** The repository's output limits; TOOL_OUTPUT_DEFAULTS where unset. */
  limits?: Partial<ToolOutputLimits>;
  /** Checks that failed on the unmodified code, with the end of that output. */
  failingBefore?: Record<string, string>;
}

export interface ToolOutputLimits {
  /** Most characters one tool result may hold. */
  maxOutputChars: number;
  /** Most lines one read_file call returns. */
  maxReadLines: number;
}

// Command output is capped like Codex CLI's (about 10 KB, start and end kept). A repository
// may set other limits up to TOOL_OUTPUT_CEILINGS (the earlier defaults).
export const TOOL_OUTPUT_DEFAULTS: ToolOutputLimits = { maxOutputChars: 10_000, maxReadLines: 400 };
export const TOOL_OUTPUT_CEILINGS: ToolOutputLimits = { maxOutputChars: 20_000, maxReadLines: 400 };

/**
 * Code (non-test files) may change only once a new test has failed, or the
 * agent has said why no test can show the ticket's change. Prompts asked for
 * this and models skipped it; the tools enforce it.
 */
export interface Reproduction {
  /** A check or command failed after a new test file was written. */
  shown: boolean;
  /** A new test file was written in this attempt. */
  newTest: boolean;
  /** The agent's reason for not showing the problem with a test. */
  skipped?: string;
  /** The run_command command whose failure showed the problem; verification runs it again. */
  command?: string;
}

/**
 * The command that showed the problem, as a check verification runs after
 * the repository's own: the agent's new test must pass on the final change.
 * Without it a new test file that no check runs (jq-2821, run 7) passes as
 * "verified". None when the problem was shown by a check, which runs anyway.
 */
export const agentTestCheck = (reproduction: Pick<Reproduction, "command">) =>
  reproduction.command
    ? { name: `agent's test (${reproduction.command.slice(0, 200)})`, command: ["sh", "-c", reproduction.command] }
    : undefined;

/**
 * How the problem was shown, for the reviewer. run_command can change files
 * past the gate, so a code change without a failing test is reported as such.
 */
export const describeReproduction = (reproduction: Reproduction, codeChanged: boolean) =>
  reproduction.skipped
    ? `Skipped by the agent: ${reproduction.skipped}`
    : reproduction.shown
      ? "A new test failed before the code changed."
      : codeChanged
        ? "Not shown: code outside test files changed without a new test failing first."
        : "No code outside test files changed.";

export type ToolStatus = "COMPLETED" | "DENIED" | "FAILED";

export interface ToolOutcome {
  status: ToolStatus;
  output: string;
  /** Set by finish: the agent's own verdict on the run. */
  finish?: { status: "done" | "blocked"; summary: string };
  /** Set by verdict: the reviewer's decision on the diff. */
  verdict?: ReviewVerdict;
}

export interface ReviewVerdict {
  approved: boolean;
  issues: string[];
  summary: string;
  /** Remarks that do not reject the change, for the person approving it. */
  suggestions?: string[];
  /** The reviewer's checklist answers, when it gave them. */
  checks?: Record<string, { answer: string; evidence: string }>;
}

const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 5_000_000;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_MATCH_LINE_CHARS = 300;
export const CHECK_TIMEOUT_MS = 300_000;
const MAX_COMMAND_CHARS = 4000;
// Dependencies, caches and build output of the common toolchains.
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".gradle",
]);

export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files under a directory of the repository (recursive, skips node_modules, .git and build output).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: 'Directory relative to the repository root; default "."' } },
    },
  },
  {
    name: "read_file",
    description: `Read a file. Each line is shown as its number, a tab, then the line; the number and the tab are not part of the file. At most ${TOOL_OUTPUT_DEFAULTS.maxReadLines} lines per call; use startLine/endLine to page through larger files.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repository root" },
        startLine: { type: "integer", description: "First line to read (1-based)" },
        endLine: { type: "integer", description: "Last line to read (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: `Find lines containing a piece of text (plain text, not a regex; case-insensitive). Returns up to ${MAX_SEARCH_MATCHES} matches as path:line: text.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for" },
        path: { type: "string", description: 'Directory to search; default "."' },
      },
      required: ["query"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact piece of text in a file. oldText must appear exactly once; include enough surrounding lines to make it unique. To create a new file, pass an empty oldText. Existing test files and protected paths cannot be changed; add new test files instead. Files other than tests can be changed only after a new test you wrote has failed in run_check or run_command, or after skip_reproduction.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repository root" },
        oldText: { type: "string", description: "Exact text to replace, with its indentation as in the file and without read_file's line numbers and the tab after them; or empty to create a new file" },
        newText: { type: "string", description: "Replacement text (the whole content for a new file)" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "run_check",
    description:
      "Run one of the repository's checks by name (for example test, lint or build, as configured for its language) and see its output.",
    parameters: {
      type: "object",
      properties: { check: { type: "string", description: "Check name, e.g. test" } },
      required: ["check"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the repository's sandbox and see its output and exit code: build, run tests or a single test, use the language's tools, inspect the environment. The working directory is the repository root; there is no network, and dependencies are already installed. Files the command changes are part of your change, and the same rules apply to them: existing test files and protected files must not change. .git is read-only.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (run with sh -c)" },
        timeoutSeconds: {
          type: "integer",
          description: `Time limit in seconds; default and maximum ${CHECK_TIMEOUT_MS / 1000}`,
        },
      },
      required: ["command"],
    },
  },
  {
    name: "skip_reproduction",
    description:
      "Say why no test can show this ticket's change (for example documentation or configuration only), so files other than tests can be changed without a failing test first. The reviewer sees the reason.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Why a test cannot show the change" } },
      required: ["reason"],
    },
  },
  {
    name: "finish",
    description:
      'End the run. Use status "done" when the change is complete, or "blocked" when the ticket cannot or should not be done (unclear, impossible or unsafe); explain why in the summary.',
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked"] },
        summary: { type: "string", description: "What was changed, or why the ticket is blocked" },
      },
      required: ["status", "summary"],
    },
  },
];

/** The reviewer's checklist (see reviewer prompts); a "no" to any rejects. */
const REVIEW_CHECKS = {
  sourceChanged: {
    question: "Does the diff change the code that produces the wrong behaviour?",
    other: [] as string[],
  },
  newCodeCalled: {
    question: "Is every name the diff adds used by the existing code the ticket is about?",
    other: ["none added"],
  },
  testsCallExistingCode: {
    question: "Do the new tests call the existing code the ticket is about?",
    other: ["no tests"],
  },
  exampleWorks: {
    question: "Does the ticket's example give the expected result with the change?",
    other: ["no example"],
  },
};

const reviewCheck = (other: string[]) =>
  z.object({ answer: z.enum(["yes", "no", ...other] as [string, ...string[]]), evidence: z.string().trim().min(1) });

const ARGS = {
  list_files: z.object({ path: z.string().optional() }),
  read_file: z.object({
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  search_code: z.object({ query: z.string().min(1), path: z.string().optional() }),
  edit_file: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
  run_check: z.object({ check: z.string() }),
  run_command: z.object({
    command: z.string().min(1).max(MAX_COMMAND_CHARS),
    timeoutSeconds: z.number().int().positive().max(CHECK_TIMEOUT_MS / 1000).optional(),
  }),
  skip_reproduction: z.object({ reason: z.string().trim().min(1) }),
  finish: z.object({ status: z.enum(["done", "blocked"]), summary: z.string().min(1) }),
  verdict: z.object({
    sourceChanged: reviewCheck(REVIEW_CHECKS.sourceChanged.other),
    newCodeCalled: reviewCheck(REVIEW_CHECKS.newCodeCalled.other),
    testsCallExistingCode: reviewCheck(REVIEW_CHECKS.testsCallExistingCode.other),
    exampleWorks: reviewCheck(REVIEW_CHECKS.exampleWorks.other),
    issues: z.array(z.string()),
    suggestions: z.array(z.string()).default([]),
    summary: z.string().min(1),
  }),
};

const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_code"]);

/**
 * The reviewer's tools: reading the changed repository, then one verdict.
 * executeTool refuses everything else when given this list.
 */
export const REVIEW_TOOLS: ToolDefinition[] = [
  ...SANDBOX_TOOLS.filter((tool) => READ_ONLY_TOOLS.has(tool.name)),
  {
    name: "verdict",
    description:
      "End the review: answer every checklist item with its evidence and list any other problems. Any \"no\" answer or listed issue rejects the change.",
    parameters: {
      type: "object",
      properties: {
        ...Object.fromEntries(
          Object.entries(REVIEW_CHECKS).map(([name, check]) => [
            name,
            {
              type: "object",
              description: check.question,
              properties: {
                answer: { type: "string", enum: ["yes", "no", ...check.other] },
                evidence: { type: "string", description: "File and line, or the search you ran" },
              },
              required: ["answer", "evidence"],
            },
          ]),
        ),
        issues: {
          type: "array",
          items: { type: "string" },
          description: "Problems that make the change wrong (see the prompt); each rejects it. Empty if none",
        },
        suggestions: {
          type: "array",
          items: { type: "string" },
          description: "Other remarks (style, comments, naming, unused inputs); shown to the approver, never reject",
        },
        summary: { type: "string", description: "What you checked and what you concluded" },
      },
      required: [...Object.keys(REVIEW_CHECKS), "issues", "summary"],
    },
  },
];

/**
 * Turns the reviewer's answers into the decision, so a reviewer that finds
 * a problem cannot still approve: any "no" or listed issue rejects.
 */
const decideReview = (args: z.infer<typeof ARGS.verdict>): ReviewVerdict => {
  const { issues, suggestions, summary, ...checks } = args;
  const failedChecks = Object.entries(checks)
    .filter(([, check]) => check.answer === "no")
    .map(([name, check]) => `${REVIEW_CHECKS[name as keyof typeof REVIEW_CHECKS].question} No: ${check.evidence}`);
  const problems = [...failedChecks, ...issues.map((issue) => issue.trim()).filter(Boolean)];
  const remarks = suggestions.map((remark) => remark.trim()).filter(Boolean);
  return { approved: problems.length === 0, issues: problems, suggestions: remarks, summary, checks };
};

const completed = (output: string): ToolOutcome => ({ status: "COMPLETED", output });
const denied = (output: string): ToolOutcome => ({ status: "DENIED", output });
const failed = (output: string): ToolOutcome => ({ status: "FAILED", output });

const limit = (ctx: ToolContext, name: keyof ToolOutputLimits) => ctx.limits?.[name] ?? TOOL_OUTPUT_DEFAULTS[name];

/**
 * Caps output. File and search results keep the start; command output keeps
 * the start and the end (where errors are), half each.
 */
const cap = (ctx: ToolContext, text: string, keep: "head" | "ends" = "head") => {
  const max = limit(ctx, "maxOutputChars");
  if (text.length <= max) return text;
  if (keep === "head") return `${text.slice(0, max)}\n[output truncated: ${text.length} characters, showing the first ${max}]`;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[output truncated: ${text.length} characters, showing the first and last ${half}]\n${text.slice(-half)}`;
};

/** Applies the path rules shared by every file tool; a string is a denial. */
const checkPath = (ctx: ToolContext, filePath: string) => {
  const resolved = resolveInsideRoot(ctx.root, filePath);
  if (!resolved) return `Path "${filePath}" is outside the repository.`;
  if (isGitPath(resolved.relativePath)) return "Git metadata (.git) is off limits.";
  if (findSymlink(ctx.root, resolved.relativePath))
    return `Path "${filePath}" goes through a symbolic link, which is not allowed.`;
  return resolved;
};

const isBinary = (buffer: Buffer) => buffer.subarray(0, 8000).includes(0);

/** Files below `dir` (relative paths), skipping build output and symlinks. */
const walk = (ctx: ToolContext, dir: string, limit: number) => {
  const files: string[] = [];
  let truncated = false;
  const visit = (relativeDir: string) => {
    const entries = fs
      .readdirSync(path.join(ctx.root, relativeDir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const relative = relativeDir === "." ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  visit(dir);
  return { files, truncated };
};

const listFiles = (ctx: ToolContext, args: z.infer<typeof ARGS.list_files>) => {
  const target = checkPath(ctx, args.path || ".");
  if (typeof target === "string") return denied(target);
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isDirectory())
    return failed(`"${args.path}" is not a directory.`);
  const { files, truncated } = walk(ctx, target.relativePath || ".", MAX_LIST_ENTRIES);
  const note = truncated ? `\n[only the first ${MAX_LIST_ENTRIES} files are listed; list a subdirectory]` : "";
  return completed(cap(ctx, `${files.join("\n") || "(no files)"}${note}`));
};

const readFile = (ctx: ToolContext, args: z.infer<typeof ARGS.read_file>) => {
  const target = checkPath(ctx, args.path);
  if (typeof target === "string") return denied(target);
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile())
    return failed(`File "${args.path}" does not exist.`);
  if (fs.statSync(target.fullPath).size > MAX_READ_BYTES)
    return failed(`File "${args.path}" is too large to read.`);
  const buffer = fs.readFileSync(target.fullPath);
  if (isBinary(buffer)) return failed(`File "${args.path}" is binary.`);

  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = args.startLine ?? 1;
  if (start > lines.length) return failed(`"${args.path}" has only ${lines.length} lines.`);
  const end = Math.min(args.endLine ?? lines.length, lines.length, start + limit(ctx, "maxReadLines") - 1);
  const body = lines
    .slice(start - 1, end)
    // A tab, as `cat -n` does: with "12: " models copied the space into edit_file's oldText.
    .map((line, index) => `${start + index}\t${line}`)
    .join("\n");
  const more = end < lines.length ? `\n[more: lines ${end + 1}-${lines.length}; call read_file with startLine ${end + 1}]` : "";
  return completed(cap(ctx, `${target.relativePath} (lines ${start}-${end} of ${lines.length})\n${body}${more}`));
};

const searchCode = (ctx: ToolContext, args: z.infer<typeof ARGS.search_code>) => {
  const target = checkPath(ctx, args.path || ".");
  if (typeof target === "string") return denied(target);
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isDirectory())
    return failed(`"${args.path}" is not a directory.`);
  const query = args.query.toLowerCase();
  const matches: string[] = [];
  for (const file of walk(ctx, target.relativePath || ".", Number.MAX_SAFE_INTEGER).files) {
    const fullPath = path.join(ctx.root, file);
    if (fs.statSync(fullPath).size > MAX_SEARCH_FILE_BYTES) continue;
    const buffer = fs.readFileSync(fullPath);
    if (isBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLowerCase().includes(query)) continue;
      matches.push(`${file}:${index + 1}: ${lines[index].trim().slice(0, MAX_MATCH_LINE_CHARS)}`);
      if (matches.length >= MAX_SEARCH_MATCHES)
        return completed(cap(ctx, `${matches.join("\n")}\n[stopped at ${MAX_SEARCH_MATCHES} matches; narrow the query or path]`));
    }
  }
  return completed(cap(ctx, matches.join("\n") || `No matches for "${args.query}".`));
};

const editFile = (ctx: ToolContext, args: z.infer<typeof ARGS.edit_file>) => {
  const target = checkPath(ctx, args.path);
  if (typeof target === "string") return denied(target);
  const file = target.relativePath;
  if (isProtectedPath(file, ctx.protectedPaths))
    return denied(`"${file}" is protected and cannot be changed. Protected: ${ctx.protectedPaths.join(", ")}.`);
  const exists = fs.existsSync(target.fullPath);
  if (exists && !fs.statSync(target.fullPath).isFile()) return failed(`"${file}" is not a file.`);
  const testFile = ctx.isTestFile(file);
  if (exists && testFile && ctx.isBaseFile(file))
    return denied(`"${file}" is an existing test file and cannot be changed. Add new tests in a new file instead.`);
  if (!testFile && !ctx.reproduction.shown && !ctx.reproduction.skipped)
    return denied(
      "Show the problem before changing code: add a test in a new test file that calls the existing code the ticket is about and expects what the ticket asks for, then run it with run_check or run_command and see it fail. If no test can show this change (for example documentation or configuration only), call skip_reproduction with the reason. If the ticket should not be done at all, call finish with status blocked and the reason.",
    );

  let content: string;
  if (args.oldText === "") {
    if (exists) return failed(`"${file}" already exists; pass the text to replace as oldText.`);
    content = args.newText;
  } else {
    if (!exists) return failed(`File "${file}" does not exist; pass an empty oldText to create it.`);
    const current = fs.readFileSync(target.fullPath, "utf8");
    // Models write \n; keep a CRLF file's line endings intact.
    const crlf = current.includes("\r\n") && !args.oldText.includes("\r\n");
    const oldText = crlf ? args.oldText.replace(/\n/g, "\r\n") : args.oldText;
    const newText = crlf ? args.newText.replace(/\n/g, "\r\n") : args.newText;
    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) return failed(`oldText was not found in "${file}". Read the file and copy the text exactly.`);
    if (occurrences > 1)
      return failed(`oldText appears ${occurrences} times in "${file}"; include more surrounding lines so it is unique.`);
    content = current.replace(oldText, () => newText);
  }
  if (Buffer.byteLength(content, "utf8") > config.generatedCodeMaxFileBytes)
    return denied(`The result would exceed the ${config.generatedCodeMaxFileBytes}-byte file limit.`);

  fs.mkdirSync(path.dirname(target.fullPath), { recursive: true });
  fs.writeFileSync(target.fullPath, content);
  if (testFile) ctx.reproduction.newTest = true;
  return completed(exists ? `Edited ${file}.` : `Created ${file}.`);
};

/** A failing run after a new test was written opens the gate; says so in the output. A timeout shows nothing. */
const noteReproduction = (ctx: ToolContext, result: SandboxResult, command?: string) => {
  if (ctx.reproduction.shown || !ctx.reproduction.newTest || result.exitCode === 0) return "";
  if (result.timedOut)
    return "\n[A run that times out shows nothing about the ticket: your test probably hangs, for example on a server, connection or timer it leaves open. Make the test finish, then run it again.]";
  ctx.reproduction.shown = true;
  if (command) ctx.reproduction.command = command;
  return "\n[The failing test shows the problem; you can now change the code. Make sure it fails for the reason the ticket describes, then fix the wrong value where it comes from, not only in the code your test calls.]";
};

const runCheck = async (ctx: ToolContext, args: z.infer<typeof ARGS.run_check>) => {
  if (!ctx.checkScripts.includes(args.check))
    return denied(`"${args.check}" is not an available check. Available: ${ctx.checkScripts.join(", ") || "none"}.`);
  const result = await ctx.runCheck(args.check);
  const before = ctx.failingBefore?.[args.check];
  const note =
    noteReproduction(ctx, result) +
    (before === undefined
      ? ""
      : `\n[This check already failed before your change, on the unmodified code. Only failures that were not there before come from your change. The end of that earlier output:]\n${before.slice(-1500)}`);
  return completed(cap(ctx, `${args.check} check: ${verdict(result, CHECK_TIMEOUT_MS)}\n${result.output.trim()}`, "ends") + note);
};

const verdict = (result: SandboxResult, timeoutMs: number) =>
  result.timedOut
    ? `TIMED OUT after ${timeoutMs / 1000}s`
    : result.exitCode === 0
      ? "PASSED"
      : `FAILED (exit code ${result.exitCode})`;

const runCommand = async (ctx: ToolContext, args: z.infer<typeof ARGS.run_command>) => {
  const timeoutMs = (args.timeoutSeconds ?? CHECK_TIMEOUT_MS / 1000) * 1000;
  const result = await ctx.runCommand(args.command, timeoutMs);
  const note = noteReproduction(ctx, result, args.command);
  return completed(cap(ctx, `$ ${args.command}\n${verdict(result, timeoutMs)}\n${result.output.trim()}`, "ends") + note);
};

/** Runs one tool call. Unknown tools and invalid arguments are FAILED results. */
export const executeTool = async (
  ctx: ToolContext,
  name: string,
  rawArgs: Record<string, unknown>,
  tools: ToolDefinition[] = SANDBOX_TOOLS,
): Promise<ToolOutcome> => {
  if (!tools.some((tool) => tool.name === name))
    return failed(`Unknown tool "${name}". Available: ${tools.map((tool) => tool.name).join(", ")}.`);
  const parsed = ARGS[name as keyof typeof ARGS].safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failed(`Invalid arguments for ${name}: ${issue.path.join(".") || "input"} ${issue.message}.`);
  }
  try {
    switch (name) {
      case "list_files":
        return listFiles(ctx, parsed.data as z.infer<typeof ARGS.list_files>);
      case "read_file":
        return readFile(ctx, parsed.data as z.infer<typeof ARGS.read_file>);
      case "search_code":
        return searchCode(ctx, parsed.data as z.infer<typeof ARGS.search_code>);
      case "edit_file":
        return editFile(ctx, parsed.data as z.infer<typeof ARGS.edit_file>);
      case "run_check":
        return await runCheck(ctx, parsed.data as z.infer<typeof ARGS.run_check>);
      case "run_command":
        return await runCommand(ctx, parsed.data as z.infer<typeof ARGS.run_command>);
      case "skip_reproduction":
        ctx.reproduction.skipped = (parsed.data as z.infer<typeof ARGS.skip_reproduction>).reason;
        return completed("Noted. You can change files other than tests now; the reviewer will see your reason.");
      case "verdict": {
        const verdict = decideReview(parsed.data as z.infer<typeof ARGS.verdict>);
        // finish ends the loop; the verdict carries the decision.
        return {
          ...completed(`Review ${verdict.approved ? "approved" : "rejected"}.`),
          finish: { status: verdict.approved ? "done" : "blocked", summary: verdict.summary },
          verdict,
        };
      }
      default: {
        const args = parsed.data as z.infer<typeof ARGS.finish>;
        return { ...completed(`Finished (${args.status}).`), finish: args };
      }
    }
  } catch (error) {
    // Filesystem errors (permissions, races) are results the agent can see,
    // without the host's directory layout.
    const message = error instanceof Error ? error.message : String(error);
    return failed(`${name} failed: ${message.split(ctx.root).join(".")}`);
  }
};
