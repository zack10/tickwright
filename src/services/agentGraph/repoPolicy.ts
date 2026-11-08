export interface RepositoryPolicy {
  maxChangedFiles?: number;
  protectedPaths?: string[];
  /** Tool result limits for the agent; see TOOL_OUTPUT_DEFAULTS. */
  maxToolOutputChars?: number;
  maxReadLines?: number;
  /** How long setup may run, in seconds; default 900. */
  setupTimeoutSeconds?: number;
  /** Model calls per agent attempt; default AGENT_MAX_STEPS (30). */
  maxAgentSteps?: number;
  /** How long a run may take, in seconds; default EXECUTION_MAX_DURATION_SECONDS (1800). */
  maxRunSeconds?: number;
}

// Used only when no toolchain is known; normally the toolchain's
// protectedPaths (its manifests and lockfiles) are the default.
export const DEFAULT_PROTECTED_PATHS = ["package.json", "package-lock.json", ".github"];
const DEFAULT_MAX_CHANGED_FILES = 20;

/** True when `file` is a protected path or lies inside one. */
export const isProtectedPath = (file: string, protectedPaths: string[]) =>
  protectedPaths.some(
    (protectedPath) =>
      file === protectedPath || file.startsWith(`${protectedPath}/`),
  );

/**
 * Returns feedback the agent can act on, or undefined when the change is
 * allowed. Violations are retried like failed verification, not thrown.
 */
export const checkRepositoryPolicy = (
  files: string[],
  policy: RepositoryPolicy | null | undefined,
  defaultProtectedPaths = DEFAULT_PROTECTED_PATHS,
): string | undefined => {
  const maxChangedFiles = policy?.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const protectedPaths = policy?.protectedPaths ?? defaultProtectedPaths;

  const issues: string[] = [];
  if (files.length > maxChangedFiles)
    issues.push(
      `The change touches ${files.length} files; the limit is ${maxChangedFiles}. Make a smaller change.`,
    );
  const protectedFiles = files.filter((file) =>
    isProtectedPath(file, protectedPaths),
  );
  if (protectedFiles.length)
    issues.push(
      `The change modifies protected paths: ${protectedFiles.join(", ")}. Do not change: ${protectedPaths.join(", ")}.`,
    );

  return issues.length
    ? `Repository policy rejected the change. ${issues.join(" ")}`
    : undefined;
};

/**
 * Existing tests define what "working" means, so the change may add tests
 * but not modify or delete ones that exist at the base commit. Checked on
 * the final diff, because the agent can change files with commands as well
 * as with edit_file.
 */
export const checkExistingTests = (
  changes: Array<{ status: string; file: string }>,
  isTestFile: (file: string) => boolean,
): string | undefined => {
  const touched = changes.filter((change) => change.status !== "A" && isTestFile(change.file));
  if (!touched.length) return undefined;
  const describe = (change: { status: string; file: string }) =>
    `${change.file} (${change.status === "D" ? "deleted" : "modified"})`;
  return `Repository policy rejected the change. Existing test files must not be changed or deleted: ${touched.map(describe).join(", ")}. Restore them and add new test files instead.`;
};
