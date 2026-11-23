import axios from "axios";

const stripQuery = (url: string | undefined) => url?.split("?")[0] ?? "";

/**
 * Describes an error for logs without request config, headers, or query
 * strings, which can carry API keys and tokens (axios errors include them).
 */
export const describeError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const method = error.config?.method?.toUpperCase() ?? "";
    const url = stripQuery(error.config?.url);
    const status = error.response?.status ?? error.code ?? "no response";
    return `${method} ${url} failed (${status}): ${error.message}`.trim();
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};

/**
 * Errors that will fail the same way on every retry (policy violations,
 * snapshot mismatches). Consumers skip retries and fail fast.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
    // new.target: a subclass (SetupFailedError) keeps its own prototype.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A NonRetryableError whose message Tickwright wrote itself, with no command or provider output in it, so the ticket can show it. */
export class ReportableError extends NonRetryableError {
  name = "ReportableError";
}
