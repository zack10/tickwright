import crypto from "node:crypto";
import { z } from "zod";
import { ReadRepoFile, commandText, parseVerificationConfig } from "./index";
import { Toolchain } from "./types";

/**
 * Environment discovery: when a repository has no approved checks, the
 * agent proposes an image, setup and checks from the project's own files,
 * and the proposal is proved by running setup and the checks on the
 * unmodified code. A failure goes back to the agent to revise. Nothing here
 * knows a language: the model reads the files, the run proves the result.
 * Model and workspace are passed in, so this has no I/O of its own.
 */

/** What discovery chose. Fields the project fixed (its devcontainer, the configuration) are left out. */
export interface EnvironmentProposal {
  image?: string;
  setup?: string[] | null;
  checks: Record<string, string[]>;
  /** Variables setup and every check run with: an `export` in setup is gone by the time a check runs. */
  env?: Record<string, string>;
  language?: string;
}

/** A proved proposal as stored on the repository until a person approves it. */
export interface StoredProposal {
  toolchain: EnvironmentProposal;
  rationale: string;
  executionId: string;
  proposedAt: string;
  /** Approval must name this hash, so what is approved is what was proved. */
  hash: string;
}

export interface ProofResult {
  /** Starting the image or the setup command failed: its output. */
  setupError?: string;
  baseline: Array<{ check: string; passed: boolean; output: string }>;
}

export interface DiscoveryAttempt {
  proposal: EnvironmentProposal | null;
  outcome: "invalid" | "setup_failed" | "checks_failed" | "works";
  detail: string;
}

export interface DiscoveryResult<P extends ProofResult> {
  proven: boolean;
  proposal?: EnvironmentProposal;
  rationale: string;
  /** The proof of the proposal that works: its setup is the run's setup. */
  proof?: P;
  attempts: DiscoveryAttempt[];
  fromStored: boolean;
}

/** What the project already decides; discovery proposes only the rest. */
export interface FixedEnvironment {
  image?: string;
  setup?: string[] | null;
  env?: Record<string, string>;
  services?: Toolchain["services"];
}

export const hashProposal = (proposal: EnvironmentProposal) =>
  crypto.createHash("sha256").update(JSON.stringify(proposal)).digest("hex");

/** The run's toolchain: the resolved one with what discovery chose. */
export const applyProposal = (base: Toolchain, proposal: EnvironmentProposal): Toolchain => ({
  ...base,
  ...(proposal.language ? { language: proposal.language } : {}),
  ...(proposal.image ? { image: proposal.image } : {}),
  ...(proposal.setup !== undefined ? { setup: proposal.setup } : {}),
  ...(proposal.env ? { env: { ...base.env, ...proposal.env } } : {}),
  checks: proposal.checks,
});

const shell = (command: string) => ["sh", "-c", command];

const replySchema = z.object({
  works: z.boolean().optional(),
  image: z.string().optional(),
  setup: z.string().nullable().optional(),
  checks: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  language: z.string().max(100).optional(),
  rationale: z.string().optional(),
});

type Reply =
  | { works: true }
  | { works: false; proposal: EnvironmentProposal; rationale: string }
  | { error: string };

/** Parses the model's reply; the proposal must pass the same validation as a configured environment. */
export const parseDiscoveryReply = (raw: string, fixed: FixedEnvironment): Reply => {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "The reply was not JSON." };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { error: `The reply did not match the format: ${parsed.error.issues[0]?.message}` };
  const reply = parsed.data;
  if (reply.works) return { works: true };
  if (!fixed.image && !reply.image) return { error: "No image was proposed." };

  const proposal: EnvironmentProposal = {
    ...(fixed.image ? {} : { image: reply.image }),
    ...(fixed.setup !== undefined ? {} : { setup: reply.setup?.trim() ? shell(reply.setup.trim()) : null }),
    checks: Object.fromEntries(Object.entries(reply.checks ?? {}).map(([name, command]) => [name, shell(command)])),
    ...(reply.env && Object.keys(reply.env).length ? { env: reply.env } : {}),
    ...(reply.language ? { language: reply.language } : {}),
  };
  try {
    parseVerificationConfig({ toolchain: proposal });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { works: false, proposal, rationale: reply.rationale ?? "" };
};

const describeProposal = (proposal: EnvironmentProposal, fixed: FixedEnvironment) => {
  const setup = proposal.setup !== undefined ? proposal.setup : fixed.setup;
  return [
    `Image: ${proposal.image ?? fixed.image}`,
    `Setup: ${setup ? commandText(setup) : "none"}`,
    ...Object.entries(proposal.env ?? {}).map(([name, value]) => `Env: ${name}=${value}`),
    `Checks:${Object.keys(proposal.checks).length ? "" : " none"}`,
    ...Object.entries(proposal.checks).map(([name, command]) => `- ${name}: ${commandText(command)}`),
  ].join("\n");
};

const describeProof = (proof: ProofResult) =>
  proof.setupError
    ? `Setup failed:\n${proof.setupError}`
    : [
        "Setup succeeded. The checks on the unmodified code:",
        ...proof.baseline.map((result) =>
          result.passed
            ? `- ${result.check}: passed`
            : `- ${result.check}: failed\n${result.output.slice(-3000)}`,
        ),
      ].join("\n");

export const discoverEnvironment = async <P extends ProofResult>(
  input: { fixed: FixedEnvironment; stored?: EnvironmentProposal; storedRationale?: string; maxAttempts: number },
  deps: {
    ask: (lastAttempt: string) => Promise<string>;
    prove: (proposal: EnvironmentProposal) => Promise<P>;
  },
): Promise<DiscoveryResult<P>> => {
  const attempts: DiscoveryAttempt[] = [];
  // What the project fixes now wins over a stored proposal made before it did.
  let proposal: EnvironmentProposal | null = input.stored
    ? {
        ...input.stored,
        ...(input.fixed.image ? { image: undefined } : {}),
        ...(input.fixed.setup !== undefined ? { setup: undefined } : {}),
      }
    : null;
  let rationale = input.stored ? (input.storedRationale ?? "Proposed by an earlier run.") : "";
  let lastAttempt = "None.";
  const fromStored = Boolean(input.stored);
  // Proposals already proved and found wanting: proving one again would fail the same way.
  const failed = new Set<string>();

  const ask = async () => {
    const reply = parseDiscoveryReply(await deps.ask(lastAttempt), input.fixed);
    if ("error" in reply) {
      attempts.push({ proposal: null, outcome: "invalid", detail: reply.error });
      lastAttempt = `Your last reply could not be used: ${reply.error}`;
    }
    return reply;
  };

  // Each round proves one proposal; asking the model comes before or after.
  for (let round = 0; round < input.maxAttempts; round++) {
    if (!proposal) {
      const reply = await ask();
      if ("error" in reply) continue;
      if (reply.works) {
        attempts.push({ proposal: null, outcome: "invalid", detail: "replied that it works before anything was tried" });
        lastAttempt = "Nothing has been tried yet: propose an environment.";
        continue;
      }
      ({ proposal, rationale } = reply);
    }
    if (failed.has(hashProposal(proposal))) {
      attempts.push({ proposal, outcome: "invalid", detail: "the same proposal as one that already failed" });
      lastAttempt = `${lastAttempt}\n\nYou then proposed exactly this environment again. It already failed as shown above: propose a different one.`;
      proposal = null;
      continue;
    }
    failed.add(hashProposal(proposal));
    const proof = await deps.prove(proposal);
    const tried = `${describeProposal(proposal, input.fixed)}\n\n${describeProof(proof)}`;
    if (proof.setupError) {
      // The first line says how it failed (exit code, killed by timeout); the end, where.
      const [status] = proof.setupError.split("\n", 1);
      attempts.push({ proposal, outcome: "setup_failed", detail: `${status}\n...\n${proof.setupError.slice(-1000)}` });
      lastAttempt = tried;
      proposal = null;
      continue;
    }
    const works = (): DiscoveryResult<P> => {
      attempts.push({ proposal: proposal!, outcome: "works", detail: "" });
      return { proven: true, proposal: proposal!, rationale, proof, attempts, fromStored };
    };
    if (proof.baseline.every((result) => result.passed)) return works();

    // A failing check may be the project's own failing test, which says
    // nothing about the environment; the model tells which it is.
    lastAttempt = tried;
    const reply = await ask();
    if (!("error" in reply) && reply.works) return works();
    attempts.push({
      proposal,
      outcome: "checks_failed",
      detail: proof.baseline.filter((result) => !result.passed).map((result) => result.check).join(", "),
    });
    proposal = "error" in reply ? null : reply.proposal;
    if (!("error" in reply)) rationale = reply.rationale;
  }
  return { proven: false, rationale, attempts, fromStored };
};

// What discovery reads: what the project says about how it is built and
// tested. Instruction files and CI configuration first, then the other files
// at the root (build and dependency files of any ecosystem live there), then
// files one level down (subprojects), smallest first. Only tracked files.
const FIRST = /^(readme|contributing|agents\.md|claude\.md|makefile|justfile|jenkinsfile)|^\.(github\/workflows|gitlab-ci|circleci|devcontainer|buildkite)|^azure-pipelines/i;
const MAX_TREE = 300;
const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 60_000;

/** The repository files the discovery prompt shows: the tree, and the contents that say how it is built. */
export const discoveryFiles = (read: ReadRepoFile, tracked: string[]) => {
  const files = [...tracked].sort();
  const depth = (file: string) => file.split("/").length - 1;
  const contents = files
    .map((file) => ({ file, text: read(file) }))
    .filter((entry): entry is { file: string; text: string } => entry.text !== undefined && !entry.text.includes("\0"))
    .map((entry) => ({ ...entry, rank: FIRST.test(entry.file) ? 0 : depth(entry.file) === 0 ? 1 : depth(entry.file) === 1 ? 2 : 3 }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.text.length - b.text.length || a.file.localeCompare(b.file));

  const shown: string[] = [];
  let total = 0;
  for (const { file, text } of contents) {
    const body = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n[truncated: ${text.length} characters]` : text;
    if (total + body.length > MAX_TOTAL_CHARS) continue;
    total += body.length;
    shown.push(`--- ${file} ---\n${body}`);
  }
  const tree = files.slice(0, MAX_TREE).join("\n") + (files.length > MAX_TREE ? `\n(${files.length - MAX_TREE} more files)` : "");
  return `File tree (tracked files):\n${tree}\n\nFile contents:\n${shown.join("\n\n") || "(none)"}`;
};
