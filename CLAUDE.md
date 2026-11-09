# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker-compose up -d            # Postgres (host port 15432) + RabbitMQ (AMQP 15673, mgmt UI 25672)
npm run dev:local               # ts-node-dev with .env.local (default `npm run dev`)
npm run dev:cloud               # same with .env.cloud (Prisma Accelerate)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build   # production stack; evals and live checks run against it, from WSL2 on Windows (docs/guides/PRODUCTION_RUN.md)
npm run build                   # prisma generate + tsc -> dist/
npm run lint                    # eslint . --ext .ts  (lint:fix to autofix)
npm test                        # build, then node:test over tests/*.test.js
npm run verify                  # lint + test
npm run test:e2e                # tests/e2e/* against a RUNNING server, env from .env.e2e (see .env.e2e.example)
npm run eval:coding -- --check  # coding benchmark setup check; drop --check to run it (rewrites the sandbox repo's main)
npm run eval:reviewer           # replays stored approved diffs through the reviewer alone, graded by hidden tests (--model X to compare)

npm run prisma:migrate:local    # create/apply a migration against .env.local DB
npm run prisma:migrate:deploy   # apply committed migrations (deploy)
dotenv -e .env.local -- npx prisma studio   # any prisma CLI command needs the env loaded this way
```

Tests are plain CommonJS files using `node:test` that `require("../dist/...")` — they run against **compiled output**, not `src/`. Always build before running one:

```bash
npm run build && node --test tests/llmUtils.test.js
```

New test files must be added to the explicit list in the `test` script in `package.json`. There is no Jest.

A change to a prompt or to the agent's code (plan step, run graph, tools, reviewer) is committed only after `npm run eval:coding -- --runs 3 --parallel 4` (about 25 min, $0.45 on `gpt-5.6-luna`, the model in `.env.e2e`; paid, so ask first) shows no drop in pass rate and no new wrong fixes against the last recorded x3 run. Never draw a conclusion from 1 to 3 runs of one scenario; use at least 10. Infrastructure, eval and docs changes are exempt.

Every pull request adds a plain-English line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog sections: Added, Changed, Removed, Fixed, Security), unless it only touches docs; CI fails otherwise (label `skip-changelog` to opt out). Versions follow SemVer from `package.json`; below 1.0.0 a breaking change (API contract, renamed or removed env var, migration with a manual step, a tracker `revisionHash` change) raises the minor version. To release: move Unreleased to a new dated version section, `npm version <x.y.z> --no-git-tag-version`, commit "Release vX.Y.Z", then after merging tag `vX.Y.Z` on main and create a GitHub Release from that changelog section.

`tests/e2e/` is separate: those suites call the HTTP API (and Trello/GitHub for setup and cleanup) instead of `dist/`, are not part of `npm test`, and skip themselves when their `E2E_*` variables are unset. Add new e2e files to the `test:e2e` script. Shared pipeline helpers (fixtures, Trello/GitHub, waiting on executions) are in `tests/e2e/pipeline.js`.

The coding benchmark (`tests/e2e/codingEval.js`) uses `tests/e2e/coding-scenarios/<suite>/`, one project per language or stack (`node`, `python`, `go`, `python-db` with PostgreSQL): `suite.json` (the environment the sandbox repo runs with, the grader image and commands, optional `grader.setup` and `grader.services`, the test-file pattern), `repo/` (the clean project), and each `NN-*/` has `scenario.json`, `bug/` (files planting the bug) and `hidden/` (test files added at the same paths for grading). Hidden tests must never be pushed to the sandbox repo. `tests/codingScenarios.test.js` (in `npm test`, needs Docker, skipped without it) proves each scenario is valid in its grader image; keep it passing when editing scenarios. A new language is a new suite folder, not a code change.

## No lock-in requirement

The agent must work on repositories in **any language, framework and platform** (PHP, Java, Python, Go, Rust, .NET, Node, ...), from any source host and issue tracker, and on any kind of task, not only Node/TypeScript bug fixes from Trello to GitHub. Today it is still limited in all of these ways; every known limitation, where it is in the code and the phase that removes it, is in the "Known limitations" table of `docs/plans/AGENTIC_ROADMAP.md` (language and toolchain: Phase 4; source host, tracker, ticket attachments, target branch: Phase 5; task types and multi-repository work: Phase 6; PR feedback: Phase 7; non-Linux platforms and running the app: Phase 14). In all new work:

- Never hard-code a language, package manager, build tool, test runner or test-file pattern in new code or prompts; take it from the repository's detected or configured toolchain.
- No code per language: supporting a new language must never need a code change. A repository's environment comes from its approved configuration, else the project's own definition (devcontainer), else a stock universal image, and its checks from a discovery step a person approves once, as established agents (Copilot coding agent, Codex, Devin) do. Never build or commit an environment (Dockerfile, devcontainer) for the user's project unless the ticket asks for it.
- Prompts say "a checked-out repository" and get the language, task type and check commands as variables; they don't assume the task is a bug fix.
- Don't add vendor-specific logic (GitHub, Trello, a model provider) outside its adapter; go through the adapter interfaces.
- Limits (sizes, timeouts, resources) are configurable per repository, with today's values as defaults.
- When changing Node-specific code (`workspaceService.ts`, `run_check`, `verifyWorkspace`, `repoContext.ts`, default protected paths), move it toward the toolchain model instead of extending the npm path.
- A newly found limitation of this kind goes into the roadmap's "Known limitations" table. From Phase 4 on, each phase is confirmed on the roadmap's reference projects (real projects in different stacks), which is where unknown limitations are expected to show up.

## Architecture

Express/TypeScript API (port 3001) on Prisma 7 + PostgreSQL, with RabbitMQ for async work. `src/index.ts` wires middleware (`securityHeaders` → CORS → `authenticate` → `rateLimit` on `/api`), then starts background loops: RabbitMQ connection, task queue worker, message recovery, execution workers, outbox flusher, Trello polling. If RabbitMQ is unavailable in non-production, the API still starts in degraded mode.

- `src/config.ts` is the single source of env-derived settings; `validateProductionConfig()` refuses to boot in production without `API_AUTH_TOKEN`, `CORS_ORIGINS`, `DATABASE_URL`, `ENCRYPTION_KEY`.
- `src/db.ts` exports the Prisma client: Accelerate client if `DATABASE_URL` starts with `prisma`, otherwise the `@prisma/adapter-pg` driver adapter over a `pg` Pool. `prisma.config.ts` supplies a dummy URL so `prisma generate` works without secrets.
- Request flow: `routes/` → `controllers/` (wrapped in `asyncHandler`, validated with Zod schemas from `schemas/index.ts` via `middleware/validate`) → `services/`. Throw `AppError` (`errors/AppError.ts`); `middleware/errorHandler` formats responses.

There are two independent async pipelines:

### 1. Task pipeline (original MVP)
`POST /api/tasks` persists a Task (honouring `Idempotency-Key`) and returns 202. `taskQueueService` publishes the task ID to a durable topic exchange with publisher confirms, a worker atomically claims it with a lease, and `agentRunner` builds a prompt (`promptBuilder`), calls the agent's LLM via `services/llm/LLMService` (Gemini/OpenAI/Anthropic providers), and parses structured output with `utils/llmUtils.parseAgentOutput`. Failures go through a dead-letter delayed retry queue up to `TASK_MAX_ATTEMPTS`; a periodic sweep re-queues pending tasks and expired leases. Generated files are written only under `generated-code/<project>/` by `utils/codeWriter` with file-count/size limits.

### 2. Execution pipeline (Trello → GitHub draft PR vertical slice)
`WorkItem` (from Trello polling or `POST /api/integrations/:id/sync`) → `Execution`, driven by a state machine in `executionService`. State transitions write `OutboxEvent` rows in the same DB transaction; `outboxService` flushes them to RabbitMQ topics `execution.plan`, `execution.run`, `execution.publish`. `executionWorker` consumes these and deduplicates via `InboxReceipt` (transactional outbox/inbox — don't publish to RabbitMQ directly for execution state changes).

- Two human approval gates: plan approval and publish approval (`POST /api/executions/:id/approvals/plan|publish`). The plan step is real: `agentGraph/planning.ts` pins the base commit, clones it, triages and writes the agent's plan (examples of the expected behaviour, open questions), and the run follows the approved plan on that commit. A plan can be revised with feedback (`requestPlanRevision`, `revise: true`).
- People can also decide on the ticket (`services/ticketConversation.ts`): the agent comments its plan and later its change; approvers listed in the tracker connection's `approvers` reply `/approve`, `/reject <reason>`, or feedback (plan only). Replies go to the same functions as the API. The agent signs its comments and never reads signed ones; model calls shared by the plan step and the run graph live in `agentGraph/agentCalls.ts`.
- The run step executes a LangGraph state graph (`services/agentGraph/executionGraph.ts`): load_context → inspect_repo → implement_change (or agent_loop) → enforce_policy → verify_change (→ analyze_failure loop) → review_diff → create_diff_artifact / block_execution. `diffReview.ts` rejects unsafe diffs (e.g. added secrets). Its LLM prompts are versioned files in `src/prompts/execution/*.vN.md` (system + user sections, `{{variables}}`), selected in `src/prompts/index.ts`; never edit a released version, add `vN+1`. The build copies them to `dist/prompts/`.
- Work happens in a Docker-isolated clone under `WORKSPACE_ROOT` (`workspaceService`, shells out to `docker`/`git`); verification runs the repository's configured npm scripts (`Repository.verificationConfig`). Docker Desktop must be running.
- Publishing uses a GitHub App (`integrations/githubApp.ts`) to push and open a **draft** PR only.
- Issue trackers are pluggable: each implements `IssueTrackerAdapter` (`integrations/types.ts`: fetch eligible items, comment, fetch comments) and is registered in `integrations/trackerRegistry.ts`. Trello (`integrations/trelloAdapter.ts`) is the only adapter. Tracker-neutral logic (WorkItem upsert, execution creation, status comments) lives in `services/ingestionService.ts`; `services/integrationPollingService.ts` polls every registered tracker type. Adapters must keep their `revisionHash` formula stable (it is part of the execution idempotency key). Source control is still GitHub-only.
- Integration credentials are encrypted at rest (`integrationConfigService`, `utils/crypto`, needs 64-hex `ENCRYPTION_KEY`) and redacted in API responses; same for agent `config.apiKey`. Repository setup secrets (`services/setupSecrets.ts`) are encrypted too and omitted from every Prisma query by default (`db.ts`); only the setup command's `docker exec` gets them.

### Other
- `mcpService` + `services/connectors/`: connector registry; only an allowlisted HTTP connector exists (`MCP_HTTP_ALLOWED_HOSTS`, private IPs blocked unless `MCP_HTTP_ALLOW_PRIVATE_IPS=true`, redirects rejected). Not a full MCP transport.
- Rate limiter is in-process only.

## Environment

- `.env.local` → Docker Postgres + RabbitMQ at `localhost:15673` (compose remaps AMQP to avoid Windows port conflicts). `.env.example` is the template.
- Auth fails closed: `/api/*` needs `API_AUTH_TOKEN` unless `AUTH_DISABLED=true` (local only; refused in production). Empty `CORS_ORIGINS` blocks browsers.
- Approval requests must include the pending approval's `snapshotHash`.
- Consumers (`rabbitMQService.subscribe`) retry via `<queue>.retry` and dead-letter to `<queue>.dead`; throw `NonRetryableError` (`utils/safeError.ts`) for failures that will not succeed on retry. Log errors with `describeError()`, never raw axios errors (they carry keys/tokens).
- Never `prisma db push` against a migrated DB; use migrations.
- `.env.cloud` → Prisma Accelerate.
- Prisma migrations in `prisma/migrations/` are meant to be committed.
- `docs/` holds planning and reference material (`plans/`, `specs/`, `testing/`, `guides/`, `history/`); it describes intent and past phases, not necessarily current behaviour. `AUDIT.md` at the root is the live fix tracker.
- `scratch/` is gitignored for local experiments.
