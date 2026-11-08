import axios from "axios";
import { NonRetryableError, describeError } from "../../utils/safeError";

// Rate limits and overload: wait as long as the provider asks.
const RATE_LIMIT_STATUS = new Set([429, 503, 529]);
// Retried like the providers' own SDKs do: timeouts, conflicts and server
// errors usually succeed on the next try. Other HTTP errors (bad request,
// auth, not found) fail the same way every time.
const TRANSIENT_STATUS = new Set([408, 409, 500, 502, 504]);
// Connection failures, where no response arrived.
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_NETWORK",
]);
// Out of credits rather than rate limited: waiting will not help.
const PERMANENT_CODES = new Set(["insufficient_quota", "credit_balance_exhausted"]);
// A request the provider's safety filter flagged. The filter is not
// deterministic (the same conversation can pass on the next try), so it is
// retried once before failing as a rejected request.
const FLAGGED_CODES = new Set(["invalid_prompt"]);
const FLAGGED_RETRIES = 1;
const FLAGGED_DELAY_MS = 2000;

const isFlaggedRequest = (error: unknown) => {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return false;
  const code = (error.response.data as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === "string" && FLAGGED_CODES.has(code);
};
const MAX_DELAY_MS = 60_000;
const MAX_TRANSIENT_DELAY_MS = 30_000;
const PROVIDER_MESSAGE_CHARS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitStatus = (error: unknown) =>
  axios.isAxiosError(error) &&
  !!error.response &&
  RATE_LIMIT_STATUS.has(error.response.status);

const isTransientFailure = (error: unknown) =>
  axios.isAxiosError(error) &&
  (error.response
    ? TRANSIENT_STATUS.has(error.response.status)
    : NETWORK_CODES.has(error.code ?? ""));

/**
 * The provider's own explanation of a failed request (its error.message),
 * which says what was wrong with it. Anything that looks like a key or token
 * is masked: some providers echo part of the key on auth errors.
 */
export const providerMessage = (error: unknown): string | undefined => {
  if (!axios.isAxiosError(error)) return undefined;
  const body = error.response?.data as { error?: { message?: unknown } | string; message?: unknown } | undefined;
  const raw =
    typeof body?.error === "object" ? body.error.message : typeof body?.error === "string" ? body.error : body?.message;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw
    .replace(/[\w*.~+/=-]{24,}/g, "[redacted]")
    .trim()
    .slice(0, PROVIDER_MESSAGE_CHARS);
};

/** A failed request that will fail again, with the provider's reason. */
const permanentFailure = (error: unknown) => {
  const reason = providerMessage(error);
  return new NonRetryableError(`${describeError(error)}${reason ? `: ${reason}` : ""}`);
};

const isOutOfCredits = (error: unknown) => {
  if (!axios.isAxiosError(error)) return false;
  const body = error.response?.data as
    | { error?: { code?: unknown; type?: unknown } }
    | undefined;
  return [body?.error?.code, body?.error?.type].some(
    (value) => typeof value === "string" && PERMANENT_CODES.has(value),
  );
};

/** True for failures worth retrying: rate limits, overload, timeouts, server errors, dropped connections. */
export const isRetryableLLMError = (error: unknown): boolean =>
  (isRateLimitStatus(error) || isTransientFailure(error)) && !isOutOfCredits(error);

/**
 * How long the provider asked us to wait (Retry-After header, or Gemini's
 * RetryInfo "37s"), uncapped; undefined when it gave no hint.
 */
const hintedDelayMs = (error: unknown): number | undefined => {
  if (!axios.isAxiosError(error) || !error.response) return undefined;
  const header = Number(error.response.headers?.["retry-after"]);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const details = (error.response.data as { error?: { details?: Array<{ retryDelay?: unknown }> } })
    ?.error?.details;
  const hinted = details?.find((detail) => typeof detail.retryDelay === "string")?.retryDelay as
    | string
    | undefined;
  const seconds = hinted ? Number.parseFloat(hinted) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 1000 : undefined;
};

/**
 * Rate limits: the provider's hint, else exponential backoff from 10s,
 * capped at one minute. Other transient failures: 1s, 2s, 4s… (capped),
 * with jitter so clients that failed together do not retry together.
 */
export const retryDelayMs = (error: unknown, attempt: number, random = Math.random): number =>
  isRateLimitStatus(error)
    ? Math.min(hintedDelayMs(error) ?? 10_000 * 2 ** attempt, MAX_DELAY_MS)
    : Math.round(Math.min(1000 * 2 ** attempt, MAX_TRANSIENT_DELAY_MS) * (0.5 + random() / 2));

/**
 * Runs `call`, retrying rate limits, overloads, timeouts, server errors and
 * dropped connections up to `retries` times, so one failed request does not
 * fail the whole run. Requests the provider rejected (bad request, auth),
 * exhausted credits and a quota that resets later than the cap (e.g. a daily
 * free-tier limit) fail immediately as NonRetryableError, with the
 * provider's reason, so neither this loop nor the queue spends time on
 * retries that cannot succeed. Errors that are not HTTP failures (such as
 * unusable output) are passed on unchanged.
 */
export const withLLMRetry = async <T>(
  call: () => Promise<T>,
  { retries, wait = sleep }: { retries: number; wait?: (ms: number) => Promise<unknown> },
): Promise<T> => {
  let flagged = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error;
      if (isFlaggedRequest(error) && flagged < FLAGGED_RETRIES) {
        flagged++;
        await wait(FLAGGED_DELAY_MS);
        continue;
      }
      if (!isRateLimitStatus(error) && !isTransientFailure(error)) throw permanentFailure(error);
      if (isOutOfCredits(error))
        throw new NonRetryableError(`LLM account has no credits left: ${describeError(error)}`);
      const hinted = hintedDelayMs(error);
      if (hinted !== undefined && hinted > MAX_DELAY_MS)
        throw new NonRetryableError(
          `LLM quota exhausted; provider asks to retry in ${Math.round(hinted / 1000)}s: ${describeError(error)}`,
        );
      if (attempt >= retries) throw error;
      await wait(retryDelayMs(error, attempt));
    }
  }
};
