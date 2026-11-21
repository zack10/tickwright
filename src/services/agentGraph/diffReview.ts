export interface DiffReviewResult {
  passed: boolean;
  issues: string[];
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{12,}["']/i,
  // GitHub classic, app installation, OAuth, user-to-server, refresh tokens.
  /\bgh[pousr]_[a-z0-9_]{20,}\b/i,
  /\bgithub_pat_[a-z0-9_]{20,}\b/i,
  // OpenAI / Anthropic style keys (sk-..., sk-proj-..., sk-ant-...).
  /\bsk-[a-z0-9_-]{20,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
  // Basic-auth credentials embedded in URLs.
  /:\/\/[^/\s:@]+:[^/\s@]{8,}@/,
];

export const reviewDiffSafety = (
  diff: string,
  files: string[],
  /** The repository's setup secrets: never in a change, though the agent should never have seen them. */
  knownSecrets: string[] = [],
): DiffReviewResult => {
  const issues: string[] = [];

  if (!diff.trim()) {
    issues.push("Diff is empty.");
  }

  // Manifests and lockfiles are the toolchain's protectedPaths, checked on the final diff in
  // enforce_policy; a fixed Node list here refused every registered test (limitation 68).
  for (const file of files) {
    if (file.startsWith(".github/")) {
      issues.push(`Diff modifies GitHub automation path: ${file}`);
    }
  }

  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const secrets = knownSecrets.filter((secret) => secret.length >= 8);
  for (const line of addedLines) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line)) || secrets.some((secret) => line.includes(secret))) {
      issues.push("Diff appears to add a secret or credential.");
      break;
    }
  }

  if (diff.length > 200_000) {
    issues.push("Diff is too large for safe automated review.");
  }

  return { passed: issues.length === 0, issues };
};
