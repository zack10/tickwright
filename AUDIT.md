# Codebase Audit & Fix Tracker

**Audit date:** 2026-10-17
**Scope:** all of `src/` (~5k lines), `prisma/schema.prisma` + migration, `tests/`, config. At audit time: build ✅, lint ✅, 8/8 tests ✅, `npm audit`: 10 vulns (1 critical, 6 high, 3 moderate).

**Summary:** The architecture is sound (transactional outbox/inbox, leased claims, Docker sandbox, approval gates, draft-only PRs). The execution pipeline was not production-safe: most failure paths left executions stuck forever or hot-looping, and the publish step trusted a workspace that LLM-written code could tamper with.

## How to use this file

- Tick `[x]` when a fix is merged; add the commit/PR in the **Fix ref** line.
- Status legend: `TODO` · `IN PROGRESS` · `PARTIAL` · `DONE` · `WONTFIX` (add reason).
- Line numbers refer to the code as of the audit date and will drift.

## Progress

| Severity | Total | Done | Partial |
|---|---|---|---|
| Critical | 4 | **4** | 0 |
| High | 10 | **10** | 0 |
| Medium | 12 | **4 (M2, M3, M5, M7)** | 3 (M1, M9, M12) |
| Low | 10 | 1 (L10, not a bug) | 0 |
| Cleanup / docs / tests | 6 | **2 (X3, X6)** | 1 (X5) |
| Architecture | 2 | **1 (A1)** | 0 |

**Current state (2026-10-17, after fix pass 1):** build ✅ · lint ✅ · **22/22 tests ✅** · `npm audit --omit=dev`: **0 vulnerabilities** (11 high remain in dev-only tooling, see H10).

---

## Fix log

### Pass 1 — 2026-10-17: all Critical + High (uncommitted, working tree on `main`)

**Verification performed**
- `npm run build`, `npm run lint`: clean.
- `npm test`: 22/22, including 14 new regression tests in `tests/auditFixes.test.js` (code writer, secret patterns, log redaction, validation, auth, consumer retry/DLQ).
- Generated Docker/git shell scripts pass `sh -n`. The publish flow (intent-to-add diff → fresh clone → `git apply --index` → commit → force push, run twice) was simulated against a local bare repo: new files applied, planted `pre-commit`/`pre-push` hooks did **not** run, no token in `.git/config`, the re-run was idempotent.
- The new migration matches `prisma migrate diff --from-empty --to-schema` output.

**Not verified end-to-end** (no Docker daemon or GitHub App in this environment): real Docker execution, GitHub push and PR creation, RabbitMQ retry/dead-letter queues against a live broker, the lease heartbeat and recovery sweep against a live DB. Run one Trello → PR execution locally before relying on it.

**Breaking changes / action required**
1. **Run the migration:** `npm run prisma:migrate:local` (adds `Execution.leaseUntil` + index; migration `20261017000000_execution_lease`).
2. **Approvals now require `snapshotHash`:** `POST /api/executions/:id/approvals/:type` body must include `snapshotHash` (64-char hex) taken from the pending approval in `GET /api/executions/:id`. Frontend/clients must send it.
3. **Auth fails closed:** without `API_AUTH_TOKEN`, `/api/*` returns 401 unless `AUTH_DISABLED=true` (refused when `NODE_ENV=production`). `AUTH_DISABLED=true` was added to your `.env.local`.
4. **CORS fails closed:** an empty `CORS_ORIGINS` now blocks all browser origins (non-browser clients without `Origin` still work).
5. **New env vars** (all optional, defaults shown in `.env.example`): `AUTH_DISABLED`, `EXECUTION_LEASE_MS`, `CONSUMER_MAX_ATTEMPTS`, `CONSUMER_RETRY_DELAY_MS`, `LLM_MAX_OUTPUT_TOKENS`.
6. **New RabbitMQ queues** are declared automatically per consumer: `<queue>.retry` (TTL → back to the queue) and `<queue>.dead`. Inspect `*.dead` for messages that exhausted retries.
7. `LLM_MAX_OUTPUT_TOKENS` defaults to 16000; lower it for models with a smaller output cap (the provider will return a 400 otherwise).

**Files changed:** `src/utils/safeError.ts` (new), `src/services/llm/errors.ts` (new), `src/utils/codeWriter.ts`, `src/services/workspaceService.ts`, `src/services/executionWorker.ts`, `src/services/agentGraph/executionGraph.ts`, `src/services/agentGraph/diffReview.ts`, `src/services/rabbitMQService.ts`, `src/services/outboxService.ts`, `src/services/trelloPollingService.ts`, `src/services/executionService.ts`, `src/integrations/githubApp.ts`, `src/middleware/authenticate.ts`, `src/middleware/validate.ts`, `src/middleware/errorHandler.ts`, `src/controllers/executionController.ts`, `src/controllers/taskController.ts`, `src/routes/executionRoutes.ts`, `src/services/llm/providers/*.ts`, `src/services/agentRunner.ts`, `src/services/messagingService.ts`, `src/services/taskQueueService.ts`, `src/config.ts`, `src/index.ts`, `prisma/schema.prisma`, `prisma/migrations/20261017000000_execution_lease/`, `.env.example`, `package.json`, `package-lock.json`, `tests/auditFixes.test.js` (new).

**Follow-ups discovered during the fix pass** (tracked below as new items): F1–F4.

### Pass 2 — 2026-10-17: repo hygiene (X6), branch `chore/repo-hygiene`

- All previously uncommitted work (pre-existing changes + pass 1 fixes) committed in logical chunks; each commit was type-checked on its own (see the commit list in `git log main..chore/repo-hygiene`).
- Docs reorganized under `docs/` (moved, not deleted); tool folders and `scratch/` ignored; personal roadmap excluded locally.
- Not merged or pushed: review the branch, then merge into `main`.

### Pass 4 — 2026-10-19: benchmark prerequisites (M2, M3, M5, M7)

Fixed before Phase 0 of `docs/plans/AGENTIC_ROADMAP.md`, because each would skew the coding benchmark.
- **M2:** every retry starts from a clean checkout (`resetWorkspace`: `git reset --hard` + `git clean -fd -e node_modules`).
- **M3:** policy violations are a failed attempt with feedback (`agentGraph/repoPolicy.ts`), routed to `analyze_failure`, or `BLOCKED` on the last attempt.
- **M5:** dotfiles (e.g. `.env`) no longer reach the repo context sent to the LLM; `.env.example` still does.
- **M7:** the verification workspace is deleted when the run step ends (`KEEP_WORKSPACES=true` keeps it); on Linux, root-owned files are deleted from inside a container.
- Build ✅ · lint ✅ · **36/36 tests ✅** (3 new in `tests/agentGraphHelpers.test.js`; the M5 test fails on the old code).

### Pass 3 — 2026-10-17: tracker adapter refactor (A1), branch `chore/repo-hygiene`

- Issue-tracker access goes through an `IssueTrackerAdapter` registry; Trello is the only adapter (no Jira support added).
- Build ✅ · lint ✅ · **28/28 tests ✅** (6 new in `tests/trackerAdapters.test.js`).
- Behaviour change: syncing a non-tracker integration (e.g. `GITHUB`) returns 400 instead of calling the Trello API.
- Not verified against the live Trello API in this environment; the HTTP calls themselves are unchanged from before the refactor.

---

## Critical

### - [x] C1 — LLM-written code can steal the GitHub token via git hooks
**Status:** DONE · **Fix ref:** pass 1 (uncommitted)
**Where:** `src/services/workspaceService.ts`, `src/services/executionWorker.ts` (`publish`), `src/utils/codeWriter.ts`
**Problem:** Verification ran LLM-written code with `.git` writable; `commitAndPush` then ran `git commit`/`push` with network and token in that same workspace, so planted hooks ran with credentials and were invisible in the reviewed diff.
**Fix:**
- [x] New `publishApprovedDiff()`: publishes from a **fresh clone** at the recorded base SHA and applies only the approved diff bytes (`git apply --index`). The verification workspace is never committed or pushed. The old `commitAndPush` was removed.
- [x] The approved diff is read from the stored artifact and its hash re-checked against the approval before publishing.
- [x] All git invocations use `-c core.hooksPath=/dev/null -c core.fsmonitor=false`; commit/push also use `--no-verify`; diffs use `--no-ext-diff --no-textconv`.
- [x] `codeWriter` rejects any path with a `.git` segment (case-insensitive).

### - [x] C2 — Any graph failure leaves the execution stuck in `RUNNING` forever
**Status:** DONE · **Fix ref:** pass 1
**Where:** `src/services/executionWorker.ts`, `src/services/agentGraph/executionGraph.ts`, `prisma/schema.prisma`
**Fix:**
- [x] New `markExecutionFailed()` moves any non-terminal execution to `FAILED` with `lastError`, an `EXECUTION_FAILED` event and a Trello comment. It's wired as the `onExhausted` hook of all three execution consumers (plan/run/publish).
- [x] Added `Execution.leaseUntil` (+ migration). `run()` atomically claims `QUEUED` executions (or `RUNNING`/`VERIFYING` ones with an expired lease), renews the lease every `EXECUTION_LEASE_MS/3` while the graph runs, and on error releases back to `QUEUED` for a bounded retry.
- [x] `recoverStalledExecutions()` sweep (every 60s) requeues runs whose lease expired (worker crash) via the outbox.
- [x] `plan()` resumes from `PLANNING`, so a failure after the status change no longer strands it.
- [x] Trello is notified on `FAILED`.
- [x] Attempt numbers continue across retried runs (`attemptOffset`), avoiding a `TaskAttempt(planTaskId, number)` unique violation on retry.

### - [x] C3 — Failed messages hot-loop forever
**Status:** DONE · **Fix ref:** pass 1
**Where:** `src/services/rabbitMQService.ts`
**Fix:**
- [x] Failures go to `<queue>.retry` (TTL `CONSUMER_RETRY_DELAY_MS`, dead-lettered back to the queue) with an `x-attempt` header, up to `CONSUMER_MAX_ATTEMPTS`; then to `<queue>.dead` plus the `onExhausted` hook. No more `nack(requeue=true)`.
- [x] `NonRetryableError` (snapshot mismatch, base branch moved, policy violation, bad message, wrong status) skips retries.
- [x] Malformed JSON is dead-lettered instead of dropped.
- [x] The consumer callback can no longer reject (e.g. ack on a closed channel); unacked messages are redelivered after reconnect.
- [x] The workspace is wiped before each clone, so partial clones can't wedge retries.

### - [x] C4 — A brief DB outage crashes the process
**Status:** DONE · **Fix ref:** pass 1
**Where:** `src/services/outboxService.ts`, `src/services/trelloPollingService.ts` (now `integrationPollingService.ts`, see A1)
**Fix:**
- [x] Interval ticks are wrapped in try/catch with safe logging.
- [x] Overlap guards (`flushing` / `syncing` flags) skip a tick while the previous one is still running.

---

## High

### - [x] H1 — Auth disabled by default
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] Auth is skipped only with an explicit `AUTH_DISABLED=true`; startup refuses it in production. A missing token otherwise returns 401 with a clear message.
- [x] An empty `CORS_ORIGINS` now denies all browser origins.

### - [x] H2 — `validate()` discards parsed output (mass assignment, missing defaults)
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] Parsed `body`/`params`/`query` are written back to `req` (unknown keys stripped, defaults applied).
- [x] `createRepository` and `createIntegration` pick fields explicitly.

### - [x] H3 — Code writer silently drops files containing backticks
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] New line-based `parseFileActions()`: content may contain backticks; handles CRLF; a block ends at a line that is exactly a closing fence.
- [x] A `FILE:` header without an opening or closing fence throws.
- [x] All blocks are parsed before any write (no partial output). Tests added.
- Note: a markdown file whose content contains a bare ```` ``` ```` line will still end the block early. A structured JSON `files[]` contract would remove this edge case.

### - [x] H4 — Anthropic output truncated; no provider detects truncation
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] `LLM_MAX_OUTPUT_TOKENS` (default 16000) is used by Anthropic (`max_tokens`) and Gemini (`maxOutputTokens`).
- [x] New `LLMOutputError` thrown on Anthropic `stop_reason` `max_tokens`/`refusal`, OpenAI `finish_reason` `length`/`content_filter`, Gemini `MAX_TOKENS`/other non-STOP reasons/`blockReason`, and on empty output. Anthropic and Gemini join all text parts.

### - [x] H5 — GitHub token exposure
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] Git authenticates with `-c http.extraHeader="Authorization: Basic …"` computed inside the container from `$GITHUB_TOKEN`; clone URLs carry no credentials, so nothing is written to `.git/config`.
- [x] Docker gets `-e GITHUB_TOKEN` (name only); the value comes from the child process env, so it's not on the argv. Verification containers get no token at all.
- [x] `SECRET_PATTERNS` now cover `gh[pousr]_`, `github_pat_`, `sk-…` (incl. `sk-ant-`, `sk-proj-`), AWS `AKIA…`, Google `AIza…`, Slack `xox?-`, and credentials embedded in URLs.
- Residual: the token is still visible via `docker inspect` while the short-lived `--rm` container runs (see F2).

### - [x] H6 — Secrets leak into logs
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] New `describeError()` logs only method, URL without query string, status and message, never axios config or headers. Used in rabbitMQService, executionWorker, outbox, Trello polling, messagingService, taskQueueService, agentRunner, taskController, errorHandler. Trello `lastError` is stored via it as well.
- [x] Gemini key moved to the `x-goog-api-key` header (list + generate); the model name is URL-encoded.

### - [x] H7 — Concurrent approvals trigger duplicate runs
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] Approval and execution are updated with `updateMany` guarded by `status: PENDING` / `status: transition.from`; if either count ≠ 1 the transaction throws 409 and rolls back.

### - [x] H8 — Approval not bound to what the reviewer saw
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] The approve body requires `snapshotHash`; a mismatch with the pending approval returns 409. **Breaking change for clients.**

### - [x] H9 — Symlink escape from workspace on the host
**Status:** DONE · **Fix ref:** pass 1
**Fix:**
- [x] The root is `realpath`'d; every existing path segment from root to target is `lstat`'d and any symlink is rejected. Tested with a junction pointing outside the root.
- Residual: a TOCTOU window between check and write remains if something else mutates the workspace concurrently (nothing does during `implement_change`). Moving writes into the container would close it fully.

### - [x] H10 — Vulnerable dependencies
**Status:** DONE (production) · **Fix ref:** pass 1
**Fix:**
- [x] `npm audit fix` applied: **0 production vulnerabilities** (`npm audit --omit=dev`).
- Remaining: 11 high in dev-only tooling (`@typescript-eslint/*` v7 → `minimatch`/`braces`). Fixing needs a breaking upgrade to typescript-eslint v8 + ESLint 9 flat config (see F4).

---

## Follow-ups found during fix pass 1

- [ ] **F1. Recovery sweep has no attempt cap.** An execution that crashes the process every run would be requeued by `recoverStalledExecutions` indefinitely. Count lease expiries (e.g. an `Execution.runAttempts` column) and fail after N.
- [ ] **F2. Token visible via `docker inspect` during clone/publish.** Pass it via a 0600 temp file mounted read-only (or Docker secrets) instead of env.
- [ ] **F3. End-to-end verification.** Run a real Trello → plan → approve (with `snapshotHash`) → run → publish cycle with Docker + the GitHub App, including forced failures (kill the worker mid-run, revoke the token) to exercise retry, dead-letter, `FAILED` and lease recovery.
  - *Progress (2026-10-18):* automated harness added (`npm run test:e2e`, `tests/e2e/`, `.env.e2e.example`). Against real Trello, GitHub and Gemini (`gemini-flash-lite-latest`), **all three suites pass**. The full happy path ran end to end: Trello card → plan → approvals → Docker run → verified diff → **draft PR #1** on `zack10/agent-orchestration-test` (only the expected one-line README change) → Trello comment. The `gemini-flash-latest` free tier (20 requests/day) ran out during debugging. Remaining for F3: forced-failure scenarios (worker killed mid-run, revoked token) are not automated yet.
  - Bugs found by the e2e runs and fixed:
    - **Unfenced model output crashed the run.** The model was shown repo files as unfenced `FILE:` blocks and copied that format; the parser then threw out of the graph, so the queue re-ran the whole execution and left attempts stuck `RUNNING`. Now repo context uses a different delimiter, the prompt spells out the block format, and a malformed reply becomes a `FAILED` attempt (reply tail saved) that the model retries with the parse error as feedback (`executionGraph.ts`, `repoContext.ts`).
    - **Spurious mode change in every diff on Windows.** Bind mounts made every file host-written show as `100644 → 100755`, so diff review blocked every attempt. Workspace git commands now use `core.fileMode=false` (`workspaceService.ts`).
    - **Docker failures gave no reason.** The stored error was only the command line. It now includes exit code/signal and the stderr and stdout tails, with the token masked; verification failure output now includes stdout, where npm prints test failures.
    - **One rate-limited LLM call failed the whole run.** Retries now cover 429/503/529 responses, honouring `Retry-After` or Gemini's `retryDelay` (up to `LLM_RATE_LIMIT_RETRIES`, 60s cap). Exhausted credits or a quota that resets later than the cap fail fast as `NonRetryableError` (`services/llm/retry.ts`).
- [ ] **F4. Dev-tooling vulnerabilities.** Upgrade to `typescript-eslint` v8 and ESLint 9 (flat config).

---

## Medium

### - [ ] M1 — Publish is not idempotent
**Status:** PARTIAL · **Fix ref:** pass 1
**Where:** `src/services/executionWorker.ts` (`publish`)
**Problem:** Push succeeds but PR creation fails → retry breaks on the existing branch. PR created but the DB update fails → duplicate PR.
**Done in pass 1:** force-push to the execution-owned branch from a fresh clone (retry-safe); an existing open PR for the branch is reused (`findOpenPullRequest`); an existing `PULL_REQUEST` artifact short-circuits to completion.
**Remaining:**
- [ ] Handle a PR that was closed/merged between retries; record publish sub-steps explicitly.

### - [x] M2 — Retries build on dirty workspace
**Status:** DONE · **Fix ref:** pass 4
**Where:** `src/services/agentGraph/executionGraph.ts` (analyze_failure → implement_change edge)
**Problem:** Failed attempts' edits persist into the next attempt; the writer can't delete files. (Whole-run retries now re-clone; the in-graph retry loop still doesn't reset.)
**Fix:**
- [x] `git reset --hard && git clean -fd` (excluding `node_modules`) before each retry in `implement_change`.

### - [x] M3 — Policy violations crash instead of retrying
**Status:** DONE · **Fix ref:** pass 1, pass 4
**Where:** `src/services/agentGraph/executionGraph.ts` (`enforceRepositoryPolicy`)
**Done in pass 1:** violations now throw `NonRetryableError`, so the execution fails fast to `FAILED` with the reason instead of hanging (C2).
**Remaining:**
- [x] Return `{ lastFailure, route }` and route to `analyze_failure`/`block_execution` so the agent gets a chance to fix the violation.

### - [ ] M4 — Every Trello list move or edit spawns a new execution
**Status:** TODO · **Fix ref:** —
**Where:** `src/integrations/trelloAdapter.ts`
**Fix:**
- [ ] Hash only `name` + `desc`; skip creating an execution if a non-terminal one exists for the work item.

### - [x] M5 — repoContext dotfile skip uses `&&` instead of `||`
**Status:** DONE · **Fix ref:** pass 4
**Where:** `src/services/agentGraph/repoContext.ts:33`
**Fix:**
- [x] Change to `||`; add a test.

### - [ ] M6 — Long runs exceed RabbitMQ consumer timeout
**Status:** TODO · **Fix ref:** —
**Where:** `executionWorker.run`, `rabbitMQService` (single shared channel)
**Problem:** Default `consumer_timeout` is 30 min; a long run can exceed it, and the broker then closes the shared channel. (With the lease from C2, a redelivered run now waits for lease expiry instead of being lost.)
**Fix:**
- [ ] Ack after claiming (the run is then driven by DB lease state), or raise the timeout per queue; use a channel per consumer.

### - [x] M7 — Workspaces never cleaned up
**Status:** DONE · **Fix ref:** pass 4
**Where:** `src/services/workspaceService.ts` (`removeWorkspace` used only before clone and for publish workspaces)
**Fix:**
- [x] Remove the verification workspace when the run step ends. Instead of `--user` (which breaks `npm ci` as a non-root user without a writable `HOME`), root-owned files are deleted from inside a container when the host can't.

### - [ ] M8 — Outbox has no row locking
**Status:** TODO · **Fix ref:** —
**Where:** `src/services/outboxService.ts`
**Fix:**
- [ ] Claim rows with `SELECT … FOR UPDATE SKIP LOCKED` (or a `claimedBy`/`claimedUntil` update).

### - [ ] M9 — Inbox dedup is check-then-act
**Status:** PARTIAL · **Fix ref:** pass 1
**Where:** `src/services/executionWorker.ts` (`consumeOnce`)
**Done in pass 1:** messages are validated with Zod; all three handlers are status-guarded or claim-guarded, so a re-run is a no-op.
**Remaining:**
- [ ] Insert the receipt in the same transaction as the handler's state transition.

### - [ ] M10 — Execution budget not enforced
**Status:** TODO · **Fix ref:** —
**Where:** `src/services/executionService.ts` (`budget`), `src/services/agentGraph/executionGraph.ts` (`MAX_ATTEMPTS`)
**Fix:**
- [ ] Read the budget in the graph; track token usage; enforce the duration.

### - [ ] M11 — Implementation agent chosen arbitrarily
**Status:** TODO · **Fix ref:** —
**Where:** `src/services/agentGraph/executionGraph.ts` (`project.agents[0]`)
**Fix:**
- [ ] Select by explicit role/flag; error if ambiguous.

### - [ ] M12 — No LLM retry/backoff; approvals have no real actor
**Status:** PARTIAL · **Fix ref:** `src/services/llm/retry.ts`
**Where:** `src/services/llm/*`, `src/controllers/executionController.ts`
**Note:** whole-run retries (C3) now absorb transient 429s at a coarse level.
**Fix:**
- [x] Exponential backoff on 429/503/529 in `LLMService` (honours `Retry-After`, fails fast on exhausted credits or long quota waits). Timeouts are not retried.
- [ ] Per-user tokens or an actor bound to the token; record the real approver.

### - [x] M13 — Labelling one Trello card re-ran every labelled card
**Status:** DONE · **Fix ref:** 2026-11-02
**Where:** `src/integrations/trelloAdapter.ts` (`revisionHash`)
**Found:** a reference eval on a fresh database: the revision hash included whole label objects, whose `uses` count changes on every card when any card gets or loses the label, so each new labelled card gave every other labelled card a new idempotency key and a new execution (triage, plan, ticket comments).
**Fix:**
- [x] Hash only each label's `id` and `name` (labels with only a name hash as before). Existing labelled cards get one new execution after the change.

### - [x] M14 — One run's cache cleanup destroyed another run's environment snapshot
**Status:** DONE · **Fix ref:** 2026-11-05
**Where:** `src/services/workspaceService.ts` (`storeEnvironmentCache`)
**Found:** a reference eval with two runs in parallel (fd, Rust): 3 of 4 runs failed with `No such image: agent-env-<id>:latest` right after a ~10-minute setup and redid it from scratch. On Docker's containerd image store, `docker image prune` breaks any `docker commit` in progress, whatever its `--filter label=` (reproduced with plain docker: 2 of 2 commits failed with a prune loop beside them, 0 of 2 with images removed by ID). Each run pruned its repository's dangling caches after committing, so it hit the other run's commit.
**Fix:**
- [x] List the repository's dangling cache images and `docker rmi` each by ID instead of pruning. Test: a new cache replaces the old one and leaves nothing dangling.

### - [ ] M15 — A worker that lost its run lease keeps running the execution
**Status:** OPEN · **Found:** 2026-11-06
**Where:** run lease and recovery sweep (`executionWorker` / `executionService`), `setupWorkspace`
**Found:** the jq reference eval ([report](docs/testing/reference-2026-11-06.md)) while the laptop went into Modern Standby for 5 hours: leases expired, the sweep handed the runs out again, and the original workers woke up and carried on. Two setups of the same execution then raced: one's `removeEnvironmentSnapshot` removed the other's setup container mid-commit ("You cannot commit container ... which is being removed", "failed to apply diff: snapshot ... does not exist").
**Fix:**
- [ ] A worker checks it still holds the lease (heartbeat result) before each graph node and before Docker steps that create or remove the execution's containers and images, and stops if it lost it.
- [ ] Test: a run whose lease was taken over stops without touching the new owner's containers.

---

## Low

- [ ] **L1. HTTP connector SSRF gaps.** DNS rebinding TOCTOU; `isPrivateIp` misses `::ffff:x.x.x.x`, `100.64/10`, `198.18/15`; a body is sent on GET. `src/services/connectors/httpConnector.ts`. **Fix:** pin the resolved IP via a custom `lookup`, extend the ranges, drop `data` for GET.
- [ ] **L2. MCP returns fake success for unknown connector types.** `src/services/mcpService.ts`. **Fix:** throw.
- [ ] **L3. Idempotency races.** `createExecution` and `createTask` look first, then insert. **Fix:** catch P2002 and return the existing row.
- [ ] **L4. Task recovery sweep defeats the retry delay.** `taskQueueService.ts`. **Fix:** set `queuedAt` when scheduling a retry.
- [ ] **L5. `updateAgent` wipes the stored API key** when the config omits `apiKey`. **Fix:** merge with the existing config.
- [ ] **L6. Deleting an agent with tasks returns 400 "Related record not found".** **Fix:** map P2003 to 409.
- [ ] **L7. Unbounded list endpoints** (`getTasks`, `getProjects`, `getAgents`). **Fix:** pagination.
- [ ] **L8. Rate limiter keys on `req.ip` without `trust proxy`;** per-process. **Fix:** configure `trust proxy`; Redis limiter for multi-instance.
- [ ] **L9. No retention for `OutboxEvent`/`InboxReceipt`/`ExecutionEvent`.** **Fix:** cleanup job.
- [x] **L10. `artifacts/` is not gitignored.** WONTFIX (not a bug): `artifacts/` was already in the modified `.gitignore`; the audit check ran before the directory existed, so a directory-only pattern didn't match.

---

## Cleanup, docs & tests

- [ ] **X1. Remove or wire up dead code:** removed on 2026-11-08: messaging (`sendMessage`, message recovery, `constants/routing.ts`, `Message` model), `workItemService.ts` (`claimWorkItemLock`, `releaseWorkItemLock`, `transitionWorkItemStatus`), `hashFile`, and unused packages. Left: `executeMcpAction` (kept for Phase 11, now throws for unknown resource types instead of simulating); unused models `ToolCall`, `ApiContract`, `WorkItem.status`/`lock*`.
- [ ] **X2. Decide the future of the legacy Task pipeline** vs the Execution pipeline.
- [x] **X3. Docs.** DONE: `.env.example` RabbitMQ port fixed (15673) and new vars documented. README corrected (skills/MCP resources are *not* in prompts) and now documents fail-closed auth/CORS, `AUTH_DISABLED`, the approval `snapshotHash` body, `.retry`/`.dead` queues and the `FAILED` lifecycle, sandbox/publish guarantees, `LLM_MAX_OUTPUT_TOKENS`, single-test runs, the `db push` → migrations baseline, and the `docs/` layout. CLAUDE.md updated with the same rules.
- [ ] **X4. Integration tests** against docker-compose Postgres + RabbitMQ: execution happy path, approval races (H7), handler failures → `FAILED` (C2), retry cap/DLQ against a live broker (C3), lease recovery, outbox/inbox dedup, HTTP routes incl. auth/validation.
- [ ] **X5. Unit tests.** PARTIAL: added codeWriter (backticks, CRLF, `.git/`, symlinks, malformed), secret patterns, `describeError`, `validate`, auth, consumer retry/DLQ. Remaining: repoContext dotfiles (M5), provider truncation handling (H4), `decideApproval` guards (needs a DB).
- [x] **X6. Repo hygiene.** DONE (pass 2, branch `chore/repo-hygiene`):
  - [x] Pending work committed on a branch in logical chunks (see Fix log, pass 2).
  - [x] All planning/reference docs moved (none deleted) into `docs/plans`, `docs/specs`, `docs/testing`, `docs/guides`, `docs/history`. Extensionless notes got `.md` names. Tracked files were moved with `git mv` so history is kept.
  - [x] Tool state ignored: `.copilot/` and `.cline/` added (`.aider*`, `.junie/`, `.obsidian/`, `copilot/`, `opencode.json` were already ignored).
  - [x] `scratch/` untracked and ignored; the files remain on disk.
  - [x] `applied_ai_engineer_6_month_roadmap.md` (personal notes) kept in place, excluded locally via `.git/info/exclude`, not committed.

---

## Architecture

### - [x] A1 — Issue-tracker integration is hard-wired to Trello
**Status:** DONE · **Fix ref:** pass 3 (uncommitted, branch `chore/repo-hygiene`)
**Problem:** The data model was tracker-neutral (`WorkItem`, `IntegrationConnection`, `ExternalSystem` already lists `JIRA`), but every code path called Trello directly: the poller only queried `TRELLO` connections, `POST /integrations/:id/sync` called the Trello sync for any connection type, worker notifications were Trello-only, and the Trello adapter did WorkItem persistence and execution creation itself.
**Fix:**
- [x] `IssueTrackerAdapter` contract (`src/integrations/types.ts`): `fetchEligibleItems(config) → { repositoryId, items: NormalizedWorkItem[] }` and `comment(config, externalId, text)`.
- [x] Registry (`src/integrations/trackerRegistry.ts`) keyed by `IntegrationType` and `ExternalSystem`; Trello is the only registered adapter.
- [x] Trello adapter reduced to Trello API calls plus a pure `toWorkItems()` mapper; revision-hash formula unchanged (pinned by test) so existing cards keep their execution idempotency keys.
- [x] New `src/services/ingestionService.ts`: tracker-neutral WorkItem upsert + `createExecution` (`syncIntegrationConnection`) and `commentOnWorkItem`.
- [x] `trelloPollingService.ts` → `integrationPollingService.ts`, polling every registered tracker type. `INTEGRATION_POLL_INTERVAL_MS` added; `TRELLO_POLL_INTERVAL_MS` still honoured.
- [x] `POST /api/integrations/:id/sync` dispatches by connection type; non-tracker types (e.g. `GITHUB`) now return 400 instead of being sent to the Trello API.
- [x] Worker `notifyTrello` → `notifyTracker` (comments on the source ticket in whichever tracker it came from).
- [x] Tests: `tests/trackerAdapters.test.js` (pinned Trello hash, label filtering, mapping, registry dispatch, plug-in registration).

**Adding another tracker later** (deliberately not done; no Jira support exists):
1. Add the value to `IntegrationType` in `prisma/schema.prisma` + migration (`ExternalSystem` may already have it), and allow it in the `POST /integrations` route schema.
2. Implement `IssueTrackerAdapter` in `src/integrations/<tracker>Adapter.ts` with a stable `revisionHash`.
3. Register it in `trackerRegistry.ts`.

### - [ ] A2 — Source control is GitHub-only
**Status:** TODO (only when a second provider is needed) · **Fix ref:** —
**Where:** `src/integrations/githubApp.ts`, `src/services/workspaceService.ts` (`github.com` clone URLs), `src/services/executionWorker.ts` (`publish`); `Repository.provider` exists but is unused.
**Fix:**
- [ ] `ScmProvider` interface (`getBaseSha`, clone/auth, `findOpenPullRequest`, `createDraftPullRequest`) selected by `Repository.provider`.

---

## Suggested next order

1. **Verify:** F3 (one real end-to-end run); merge `chore/repo-hygiene`.
2. **Quick wins:** M5, M4, L2.
3. **Tests:** X4, rest of X5.
4. **Robustness:** M2, M3 (remaining), M6, M7, M8, F1, F2, M10–M12.
5. **Cleanup:** remaining Low items, X1–X3, F4.

## What's already good (keep it)

Transactional outbox + inbox · publisher confirms · atomic leased task claims (`updateMany`) · Docker sandbox with `--network none` during verification and `npm ci --ignore-scripts` · AES-256-GCM credential encryption · constant-time token comparison · content-bound approval hashes + base-SHA drift check before publish · draft-only PRs · production config validation.
