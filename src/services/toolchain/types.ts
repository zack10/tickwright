/**
 * Where a repository's commands run and which checks prove a change: the
 * Docker image, a setup step and named checks (tests, lint, build). It comes
 * from the repository's configuration, the project's own devcontainer, or a
 * stock universal image; there is no code per language. Nothing else in the
 * pipeline may assume a language, package manager or test runner.
 */
export interface Toolchain {
  /** Optional label for prompts and reports, e.g. "PHP (Laravel)". */
  language?: string;
  /** Sandbox image for setup, checks and the agent's commands. */
  image: string;
  /** Run once after cloning, with network but without credentials. */
  setup: string[] | null;
  /** Check name ("test", "lint", "build") to the command that runs it. */
  checks: Record<string, string[]>;
  /** Environment for every command. */
  env: Record<string, string>;
  /** Regular expressions (source) matching test files, repository-relative. */
  testFilePatterns: string[];
  /** Files the agent may not change (CI config, manifests, lockfiles). */
  protectedPaths: string[];
  /** Containers the checks need (a database, a cache), started beside each run's sandbox. */
  services?: ServiceContainer[];
}

/**
 * A container beside the sandbox, on a network shared only with that run's
 * containers and without internet. Setup, checks and the agent's commands
 * reach it by `name`.
 */
export interface ServiceContainer {
  /** Hostname it is reached by, e.g. "db". */
  name: string;
  image: string;
  env?: Record<string, string>;
  /** Run inside the service until it succeeds (e.g. `pg_isready`); without it, started counts as ready. */
  ready?: string[];
  /** How long `ready` may take to succeed; default 120. */
  readyTimeoutSeconds?: number;
}

export type ToolchainSource = "configured" | "devcontainer" | "default";

/** What was used and why, recorded with every run. */
export interface ToolchainResolution {
  toolchain: Toolchain;
  /** Where the image came from. */
  source: ToolchainSource;
  reason: string;
  /** Parts of the project's definition that were not applied. */
  notes: string[];
}

/**
 * Per-repository configuration, stored in `Repository.verificationConfig`.
 * `scripts` selects which checks run; `toolchain` sets any part of the
 * environment and wins over the project's devcontainer and the defaults.
 */
export interface VerificationConfig {
  scripts?: string[];
  toolchain?: Partial<Toolchain>;
}

/** Absolute path of the workspace inside every sandbox container. */
export const SANDBOX_ROOT = "/workspace";
