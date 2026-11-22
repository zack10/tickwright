# CLAUDE.md

Instructions for any AI model working in this repository. Read all of it before the first change. Where this file and the code disagree, the code is right: fix this file in the same change.

## 1. What this project is

Tickwright is a backend that turns tickets into reviewed code changes. It picks up a ticket from an issue tracker, an AI agent plans the change, edits the code in an isolated Docker workspace, proves it with the repository's own checks, a second model reviews the diff, and after a person approves, it opens a **draft** pull request. A person approves twice: the plan, and the exact diff.

It is an Express/TypeScript API (port 3001) on Prisma 7 + PostgreSQL, with RabbitMQ for background work and LangGraph for the run graph. One Node process serves the API and runs the workers. Every state change is stored in PostgreSQL first and reaches RabbitMQ through an outbox.

There are two independent pipelines:

1. **Task pipeline** (the original MVP). `POST /api/tasks` stores a Task (honouring `Idempotency-Key`) and returns 202. `taskQueueService` publishes the id, a worker claims it with a lease, `agentRunner` builds a prompt (`promptBuilder`), calls the model through `services/llm/LLMService`, and parses the output with `utils/llmUtils.parseAgentOutput`. Failures retry through a delayed dead-letter queue up to `TASK_MAX_ATTEMPTS`. Generated files go only under `generated-code/<project>/` (`utils/codeWriter`).
2. **Execution pipeline** (ticket to draft PR). This is where almost all current work happens. See section 4.

The product goal that shapes every decision: the agent must work on a repository in **any language, framework and platform**, from any source host and tracker, on any kind of task. Today it is still limited (GitHub and Trello only, for example). Every known limitation is a numbered row in the "Known limitations" table of `docs/plans/AGENTIC_ROADMAP.md`, with the code location and the phase that removes it.

## 2. Map of the folders

```
src/
  index.ts              wires middleware, then starts the background loops
  config.ts             the only place that reads process.env
  db.ts                 Prisma client (Accelerate or pg adapter); hides secret columns by default
  routes/               Express routers; request shapes are Zod schemas, checked by middleware/validate
  controllers/          thin handlers wrapped in asyncHandler; call services
  middleware/           securityHeaders, authenticate, rateLimit, validate, errorHandler, asyncHandler
  schemas/index.ts      shared Zod schemas (agents, skills, tasks)
  errors/AppError.ts    the error type controllers and services throw
  integrations/         vendor adapters: githubApp.ts, trelloAdapter.ts, trackerRegistry.ts, sourceControl.ts, types.ts (IssueTrackerAdapter, SourceControlAdapter)
  prompts/
    index.ts            which version of each prompt is live (EXECUTION_PROMPTS)
    execution/*.vN.md   versioned prompt files: "<!-- system -->" and "<!-- user -->" sections, {{variables}}
  services/
    executionService.ts     execution state machine: create, submit plan, approvals, plan revision
    executionWorker.ts      consumes execution.plan / .run / .publish; leases, recovery of stalled runs
    outboxService.ts        flushes OutboxEvent rows to RabbitMQ
    ingestionService.ts     tracker-neutral: WorkItem upsert, execution creation, status comments
    integrationPollingService.ts  polls every registered tracker
    ticketConversation.ts   plan and change comments on the ticket; /approve, /reject, feedback
    workspaceService.ts     everything that shells out to docker and git: clone, setup, snapshot, sandbox, verify, diff, publish
    environmentSweep.ts     removes what ended runs left behind (containers, snapshots, clones)
    feedbackIntake.ts       stores approvers' ticket replies and listed reviewers' reviews and PR comments on open PRs (ExecutionFeedback); the rules for whose text is read
    followUps.ts            starts a follow-up round on an open PR from stored feedback; how the feedback is quoted for the agent
    pullRequestOutcomes.ts  records whether the agent's PRs were merged as written, edited or closed (PULL_REQUEST_OUTCOME, MERGED_DIFF)
    setupSecrets.ts         encrypted setup and test secrets of a repository
    rabbitMQService.ts      connection, publish with confirms, subscribe with retry and dead-letter queues
    agentGraph/
      executionGraph.ts     the LangGraph run graph (the largest file)
      planning.ts           plan step: pin commit, clone, triage, write the plan
      agentLoop.ts          the tool-calling loop, its budgets and message compaction
      agentCalls.ts         model calls shared by the plan step and the run graph
      planner.ts, reviewer.ts   the planner and reviewer loops (read-only tools)
      repoPolicy.ts         protected paths, changed-file limits, the existing-tests rule
      diffReview.ts         rejects unsafe diffs (added secrets)
      repoContext.ts        the repository overview given to the model
      checkpointer.ts       durable LangGraph checkpoints in Postgres
    sandbox/
      tools.ts              the agent's tools and every safety rule on them
      toolRunner.ts         records each tool call; builds the tool context for an execution
    toolchain/
      index.ts              resolves a repository's environment and checks; test-file patterns
      discovery.ts          a model proposes an environment, it is proven, a person approves it once
      devcontainer.ts, compose.ts   read the project's own environment definition
    llm/                    LLMService, provider registry (LLM_PROVIDERS profiles), retry, usage ledger and the record of every call's request and reply (LlmCall)
      providers/            AnthropicProvider, GeminiProvider, OpenAICompatibleProvider
    connectors/, mcpService.ts   allowlisted HTTP connector; not a full MCP transport
    agentRunner.ts, taskQueueService.ts, promptBuilder.ts, projectService.ts   the task pipeline
  utils/                    crypto, safePath, safeError (describeError, NonRetryableError), codeWriter, llmUtils, agentConfig
prisma/                     schema.prisma and committed migrations
scripts/copy-prompts.js     copies prompts into dist/ at build time
scripts/trace.js            npm run trace: one execution's steps, model calls (LlmCall), tool calls and edits, read from the database
tests/
  *.test.js                 unit tests, CommonJS, node:test, run against dist/
  pipeline/                 the whole pipeline with a scripted model and in-memory tracker and code host (npm run test:pipeline)
  e2e/                      suites and evals that call a RUNNING server
    pipeline.js, helpers.js   shared fixtures, tracker and GitHub helpers, waiting on executions
    codingEval.js           the coding benchmark (npm run eval:coding)
    referenceEval.js        real open-source projects (npm run eval:reference)
    reviewerEval.js         replays stored diffs through the reviewer alone
    coding-scenarios/<suite>/   one benchmark project per stack: suite.json, repo/, NN-*/ (scenario.json, bug/, hidden/)
    reference-projects/     projects.json and tickets/
docs/
  plans/AGENTIC_ROADMAP.md  the plan of record: phases, Known limitations table, reference projects, results log
  testing/                  eval reports (coding-eval-*.md, reference-*.md), written by the evals; TESTING_PRACTICES.md: which test to run for which change
  guides/, specs/, history/ reference and past phases; may be out of date
AUDIT.md                    live fix tracker from the code audit (items like M16)
CHANGELOG.md                Keep a Changelog; every code PR adds a line
scratch/                    gitignored local experiments, launch scripts and run logs
floorplan/                  generated map of the codebase (may lag behind edits)
```

Not source, never edit or commit: `dist/`, `node_modules/`, `generated-code/`, `workspaces/`, `artifacts/`, `graphify-out/`, `.ua/`, and every `.env*` file except the three `*.example` templates.

`AGENTS.md` is out of date (it still tells you to use `prisma db push` and the wrong RabbitMQ port). Follow this file.

If `floorplan/` exists, look things up there before searching: `node floorplan/query.mjs find "<words>"`, `show <path>`, `path <from> <to>`, `overview`. Confirm in the code before changing anything.

## 3. Commands

```bash
docker-compose up -d            # dev Postgres (host port 15432) + RabbitMQ (AMQP 15673, UI 25672)
npm run dev:local               # ts-node-dev with .env.local (same as npm run dev)
npm run dev:cloud               # same with .env.cloud (Prisma Accelerate)

npm run build                   # prisma generate + tsc -> dist/, copies prompts
npm run lint                    # eslint . --ext .ts   (lint:fix to autofix)
npm test                        # build, then node:test over the listed tests/*.test.js
npm run verify                  # lint + test; this is what CI runs

npm run build && node --test tests/toolchain.test.js    # one test file; always build first

npm run prisma:migrate:local    # create or apply a migration against the .env.local database
npm run prisma:migrate:deploy   # apply committed migrations
dotenv -e .env.local -- npx prisma studio               # any prisma CLI command needs the env loaded this way

# Production stack: evals and live checks run against this, from WSL2 on Windows (docs/guides/PRODUCTION_RUN.md)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

npm run test:pipeline           # free: a ticket to COMPLETED on real Postgres, RabbitMQ and Docker; needs PIPELINE_TEST_DATABASE_URL and PIPELINE_TEST_RABBITMQ_URL (own database and vhost)
npm run test:e2e                # tests/e2e/* against a RUNNING server, env from .env.e2e
npm run eval:coding -- --check  # free setup check of the coding benchmark
npm run eval:coding -- --runs 3 --parallel 4            # the "x3" benchmark: paid, about 25 min
npm run eval:coding -- --scenario node/07-large-file-shipping --runs 10
npm run eval:reference -- cpp/catch2-2723 --runs 10     # one real project: paid
npm run eval:reviewer           # reviewer alone on stored diffs (--model X to compare)
npm run trace -- <execution id> [--follow]   # free: every step, model reply, tool call, command and edit of one execution, from the production database (no id: executions in progress)
```

Facts about testing that are easy to get wrong:

- Tests are plain CommonJS files using `node:test` that `require("../dist/...")`. They test **compiled output**. A test run without a build tests old code. There is no Jest.
- A new test file must be added to the explicit list in the `test` script in `package.json`, or it never runs. New e2e files go in the `test:e2e` script.
- `tests/codingScenarios.test.js` needs Docker and skips itself without it. It proves each benchmark scenario is valid in its grader image; keep it passing when editing scenarios.
- e2e suites skip themselves when their `E2E_*` variables are unset.
- `tests/pipeline/` is not in `npm test`: it needs a migrated Postgres and a RabbitMQ that nothing else consumes, so it has its own CI job (`pipeline`) and script. It replaces only the model (a local OpenAI-compatible server in `LLM_PROVIDERS`), the tracker and code-host adapters, and git's clone and push. A change to the prompts' first lines, the tools or the stage events can break its script; fix the script, not the pipeline.
- Hidden tests of a benchmark scenario must never be pushed to the sandbox repository.
- A new benchmark language is a new folder under `tests/e2e/coding-scenarios/`, not a code change.

## 4. How the execution pipeline is built

`WorkItem` (from tracker polling or `POST /api/integrations/:id/sync`) becomes an `Execution`, driven by the state machine in `executionService`:

`INGESTED → PLANNING → AWAITING_PLAN_APPROVAL → QUEUED → RUNNING → VERIFYING → AWAITING_PUBLISH_APPROVAL → PUBLISHING → COMPLETED`, or `BLOCKED`, `FAILED`, `CANCELED`.

- **Outbox and inbox.** A state transition writes an `OutboxEvent` row in the same database transaction. `outboxService` flushes rows to the topics `execution.plan`, `execution.run`, `execution.publish`. `executionWorker` consumes them and deduplicates with `InboxReceipt`.
- **Plan step** (`agentGraph/planning.ts`). Pins the base commit, clones it, triages the ticket and writes a plan (examples of the expected behaviour, open questions). A person approves it, rejects it, or sends feedback for a revision.
- **Run step** (`agentGraph/executionGraph.ts`). load_context → inspect_repo → agent_loop → enforce_policy → verify_change (→ analyze_failure and another attempt, at most 3) → review_diff → create_diff_artifact or block_execution.
- **Agent tools** (`sandbox/tools.ts`). list_files, read_file, search_code, edit_file, run_check, run_command, skip_reproduction, finish. The reviewer and planner get read-only sets. Every safety rule lives in the tool, not in the prompt.
- **Reproduction gate.** Files other than tests can change only after a new test has failed, or after `skip_reproduction` with a reason. The command that showed the failure is run again by verification.
- **Workspace** (`workspaceService.ts`). A Docker-isolated clone under `WORKSPACE_ROOT`. The agent's commands have no network. Verification runs in a fresh container and judges only the diff.
- **Environment** (`services/toolchain/`). A repository's image, setup and checks come from its approved configuration (`Repository.verificationConfig.toolchain`), else the project's own devcontainer, else a stock universal image plus a discovery step that a person approves once.
- **Approvals.** `POST /api/executions/:id/approvals/plan|publish` must carry the pending approval's `snapshotHash`. People can also reply on the ticket (`/approve`, `/reject <reason>`, or feedback on a plan) when listed in the tracker connection's `approvers`; those replies go to the same functions as the API. `POST /api/executions/:id/cancel` ends an execution in any non-final state; a running step stops at its next graph node or agent step (`stoppable` in `executionGraph.ts`), so status writes in the graph are conditional on not being `CANCELED`.
- **Publishing.** A GitHub App pushes from a fresh clone and opens a draft PR only (`integrations/githubApp.ts`, `publishApprovedDiff`).
- **Follow-up rounds.** Feedback stored on an open PR (`feedbackIntake.ts`: approvers' ticket replies, listed reviewers' reviews) that asks for changes starts a new `Execution` with `parentExecutionId` (`followUps.ts`, `createFollowUpExecution`). It skips the plan step (the root's plan, approved by the request), starts `QUEUED` from the PR branch's head, reads the feedback in its ticket (`follow-up.v1.md`, every line quoted), and still needs publish approval; publishing then adds a commit to the same branch without force. One round runs at a time per PR. The polls read only root executions (`parentExecutionId: null`).
- **Trackers** implement `IssueTrackerAdapter` (`integrations/types.ts`) and are registered in `trackerRegistry.ts`. Trello is the only one. Trackers and code hosts both give a `configSchema`, which `POST /api/integrations` checks.
- **Code hosts** implement `SourceControlAdapter` (`integrations/types.ts`) and are registered in `integrations/sourceControl.ts`; callers use `sourceControlFor(repository)`, picked by `Repository.provider`, with credentials from the repository's connection (`connectionId`). The adapter also supplies the git remote that `workspaceService.ts` clones and pushes from. GitHub is the only one.

Request flow for the API: `routes/` → `controllers/` (wrapped in `asyncHandler`, validated with Zod through `middleware/validate`) → `services/`. Errors are `AppError`; `middleware/errorHandler` formats the response.

### Environment and other facts

- `.env.local` points at the Docker Postgres and RabbitMQ at `localhost:15673` (compose remaps AMQP to avoid Windows port conflicts). `.env.cloud` uses Prisma Accelerate. `.env.example` is the template; `.env.e2e.example` and `.env.prod.example` are the templates for e2e runs and the production stack.
- `src/db.ts` exports the Prisma client: the Accelerate client if `DATABASE_URL` starts with `prisma`, otherwise the `@prisma/adapter-pg` driver adapter over a `pg` Pool. `prisma.config.ts` supplies a dummy URL so `prisma generate` works without secrets.
- `validateProductionConfig()` refuses to boot in production without `API_AUTH_TOKEN`, `CORS_ORIGINS`, `DATABASE_URL` and `ENCRYPTION_KEY`.
- If RabbitMQ is unavailable outside production, the API still starts in degraded mode.
- `src/index.ts` wires `securityHeaders` → CORS → `authenticate` → `rateLimit` on `/api`, then starts the loops: RabbitMQ connection, task queue worker, message recovery, execution workers, outbox flusher, tracker polling, environment sweep, pull request outcome polling. The rate limiter is in-process only.
- The HTTP connector (`services/connectors/`) is allowlisted by `MCP_HTTP_ALLOWED_HOSTS`; private IPs are blocked unless `MCP_HTTP_ALLOW_PRIVATE_IPS=true`, and redirects are rejected.
- Roadmap phases that remove today's limits: language and toolchain, Phase 4; source host, tracker, ticket attachments, target branch, Phase 5; task types and multi-repository work, Phase 6; PR feedback, Phase 7; non-Linux platforms and running the app, Phase 14. From Phase 4 on, each phase is confirmed on the roadmap's reference projects (real projects in different stacks).

## 5. Coding rules

1. **Match the file you are in.** Formatting is not uniform: most services use double quotes and wrapped lines, `routes/` uses single quotes and long one-line schemas. Do not reformat lines you are not changing; a reformatted file hides the real diff.
2. **TypeScript strict, CommonJS output.** `no-explicit-any` is a warning, unused variables are an error (prefix an intentionally unused argument with `_`).
3. **Environment variables are read only in `src/config.ts`.** Add the setting there with a default, and to `.env.example`. Add it to `validateProductionConfig()` if production cannot run without it.
4. **Throw `AppError`** from controllers and services for anything the caller should see. Throw `NonRetryableError` (`utils/safeError.ts`) from a queue consumer when a retry cannot succeed.
5. **Log errors with `describeError()`**, never a raw error object. Axios errors carry API keys and tokens in their config.
6. **Validate every request with Zod** in the route. Use `.strict()` on bodies that update things.
7. **Database changes are migrations.** Edit `schema.prisma`, run `npm run prisma:migrate:local`, commit the migration. Never `prisma db push` against a migrated database. Never accept a reset that Prisma offers.
8. **Secrets.** Integration credentials, agent `config.apiKey`, and repository setup and test secrets are encrypted at rest (`utils/crypto`, 64-hex `ENCRYPTION_KEY`) and redacted or omitted in API responses. `db.ts` omits the secret columns from every query by default. A new secret field gets the same treatment.
9. **File paths that come from a model or a request** go through `utils/safePath` (`resolveInsideRoot`, `findSymlink`, `isGitPath`).
10. **Comments say why, in one line.** Many comments here name the run that motivated a rule ("jq-2821, run 7"). Keep that habit: a rule with no recorded reason gets deleted by the next person.
11. **Prompts are versioned files.** Never edit a released `src/prompts/execution/*.vN.md`. Copy it to `vN+1`, change that, and bump the entry in `src/prompts/index.ts`. A missing or unused `{{variable}}` fails loudly on purpose; `tests/prompts.test.js` renders every live prompt.
12. **Tests go with the change.** New logic gets a test in the matching `tests/*.test.js`. Test names are full sentences that state the rule.
13. **No new dependency for a few lines of code.** Use what is installed (zod, axios, js-yaml, pg, amqplib) or the standard library.
14. **Smallest complete change.** Reuse the helper that exists. No option, wrapper or abstraction nobody asked for. But finish every part the change needs: callers, tests, fixtures, the changelog line, the roadmap row.

## 6. Design rules

### No lock-in (the rule most often broken)

- Never hard-code a language, package manager, build tool, test runner or test-file pattern in code or prompts. Take it from the repository's detected or configured toolchain.
- No code per language. Supporting a new language must never need a code change. A list of file names for one ecosystem in code (`CMakeLists.txt`, `package.json`) is this mistake.
- Never build or commit an environment (Dockerfile, devcontainer) for the user's project unless the ticket asks for it.
- Prompts say "a checked-out repository" and receive the language, task type and check commands as variables. They do not assume the task is a bug fix.
- Vendor logic (GitHub, Trello, a model provider) stays inside its adapter. Everything else goes through the adapter interfaces.
- Limits (sizes, timeouts, resources) are configurable per repository (`Repository.executionPolicy`), with today's values as defaults.
- When changing Node-specific code (`workspaceService.ts`, `run_check`, `verifyWorkspace`, `repoContext.ts`, default protected paths), move it toward the toolchain model. Do not extend the npm path.
- A newly found limitation of this kind is a new row in the roadmap's "Known limitations" table, with where it is in the code, its effect, and how it was found.

### Reliability

- Execution state changes go through `executionService` and the outbox. Never publish to RabbitMQ directly for an execution state change.
- Consumers use `rabbitMQService.subscribe`, which retries through `<queue>.retry` and dead-letters to `<queue>.dead`.
- A tracker adapter's `revisionHash` formula must stay stable: it is part of the execution idempotency key. Changing it is a breaking change.
- Docker image changes (commit, tag, remove) go through `withImageLock`.

### Safety

- Safety rules are enforced in code (`sandbox/tools.ts`, `repoPolicy.ts`, `diffReview.ts`), then checked again on the final diff, because the agent can change files with shell commands as well as with `edit_file`. A rule that exists only in a prompt is not a rule.
- The agent never gets network access, setup secrets, or the Docker socket.
- Publishing opens a draft PR only, from a fresh clone, applying only the reviewed diff.
- Auth fails closed: `/api/*` needs `API_AUTH_TOKEN` unless `AUTH_DISABLED=true`, which is refused in production. An empty `CORS_ORIGINS` blocks browsers.
- Human approval covers ambiguity. If a failure would be caught by plan approval or publish approval, record it in the roadmap and move on; do not add agent machinery for it.

## 7. Changing the agent: the evidence rules

A change to a prompt or to the agent's code (plan step, run graph, tools, reviewer, policy) is committed only after the x3 benchmark shows no drop in pass rate and no new wrong fix against the last recorded x3 run:

```bash
npm run eval:coding -- --runs 3 --parallel 4
```

- The last recorded result is the newest `docs/testing/coding-eval-*.md` with "Runs per scenario | 3". Compare run counts, correct fixes, correctly blocked, wrong fixes shipped, and infrastructure failures.
- **The x3 shows regressions only, never a gain.** It has been at its ceiling since 2026-11-11 (51 / 0 / 3), and harder synthetic scenarios did not move it (roadmap row 40). A claim that a change makes the agent better needs real tickets: reference tickets (`npm run eval:reference`, at least 10 runs of a ticket) or the user's own tickets through the tracker, with the bar set before the run.
- Infrastructure, eval and docs changes are exempt.
- **Evals test the production stack.** Before an eval of a code change, rebuild it from the working tree and confirm the running image has the change (for example `docker exec <app container> grep -c "<new text>" dist/...`). An eval against an image without the change proves nothing. Never rebuild or restart it while an execution is running: the run is lost.
- **Never draw a conclusion from 1 to 3 runs of one scenario.** Use at least 10.
- The model for every paid run is the one in `.env.e2e` (`E2E_LLM_PROVIDER`, `E2E_LLM_MODEL`). Never switch to another model on your own.

### Paid runs

Every eval spends the user's money. Before starting one:

1. State the model, the number of runs and an approximate cost, and wait for an explicit yes. An earlier yes does not cover the next run.
2. Fix three things in advance and state them: the **pass bar**, the **stop rule** (when the early runs already decide it) and the **dollar cap**.
3. Check what is free first: existing reports in `docs/testing/` and the database (`Execution`, `TaskAttempt`, `ToolCall`, `ExecutionEvent`, `LlmUsage`).
4. Confirm nothing else is running and the machine has free memory.

During and after:

- When a run fails, read that one case in the database before anything else. Do not start another run to "see if it happens again".
- Stop a batch when its early results show a cause that will repeat.
- Report against the bar that was set. If the bar is missed, say so, record what was learned in the roadmap, and stop. No diagnose, patch, rerun cycles.
- Report what a passing eval does **not** show (for example, that no run exercised the new code path).

## 8. Git, changelog and releases

- Never commit to `main`. Branch, commit, push, open a PR. Commit, push, open or merge a PR only when the user asks.
- Every PR adds a plain-English line under `## [Unreleased]` in `CHANGELOG.md` (sections: Added, Changed, Removed, Fixed, Security), unless it only touches docs. CI fails otherwise (label `skip-changelog` to opt out). Write the line for a user of the product, not for a developer.
- CI runs `npm run verify` and the changelog check. Wait for both before merging.
- Versions follow SemVer from `package.json`. Below 1.0.0 a breaking change raises the minor version: an API contract change, a renamed or removed environment variable, a migration with a manual step, a tracker `revisionHash` change.
- To release: move Unreleased to a new dated version section, `npm version <x.y.z> --no-git-tag-version`, commit "Release vX.Y.Z", then after merging tag `vX.Y.Z` on main and create a GitHub Release from that changelog section.
- Commit messages: a short imperative subject, then why, what is still open, and the eval result when one was run.

## 9. Mistakes a weaker model makes here, and how to avoid each

| # | Mistake | How to avoid it |
| --- | --- | --- |
| 1 | Running a test without building, and trusting the result | Tests load `dist/`. Always `npm run build && node --test tests/<file>.test.js`, or `npm test` |
| 2 | Adding a test file that never runs | Add it to the `test` script list in `package.json` in the same change |
| 3 | Editing a released prompt file in place | Add `vN+1` and bump `src/prompts/index.ts`. Old results must stay tied to the text that produced them |
| 4 | Fixing a limitation with a list of file names, extensions or commands for one language | Use a rule that holds in any stack, or a per-repository setting. If neither exists yet, add a roadmap row instead of a hack |
| 5 | Adding a safety rule to a prompt only | Enforce it in the tool, and again on the final diff |
| 6 | Starting an eval without asking, or with a different model | Ask first, with the cost. Use the model in `.env.e2e` |
| 7 | Running an eval against a production image that does not contain the change | Rebuild, then confirm the change is in the running container, before spending anything |
| 8 | Concluding from one or two runs | At least 10 runs of a scenario; compare x3 results only with another x3 |
| 9 | Patching again after each failed run | One bar, one stop rule, one cap, set before the run. Missed bar: record it and stop |
| 10 | Calling a limitation "fixed" when only part of it is | Say "partly fixed", list what is still open in the roadmap row, and say what is unproven |
| 11 | Assuming something left on a machine survives into verification | Verification runs each check in a new container: only the repository's files are there. The same trap applies to the agent's own test command |
| 12 | Publishing to RabbitMQ directly, or updating `Execution.status` by hand | Go through `executionService`; the outbox does the publishing |
| 13 | `prisma db push`, or accepting a database reset | Migrations only. Stop and ask if Prisma wants to reset |
| 14 | Logging a raw error, or returning a stored credential in a response | `describeError()`; redact and omit secrets as the existing fields do |
| 15 | Reading `process.env` in a service | Add the setting to `src/config.ts` |
| 16 | Trusting `docs/` or `AGENTS.md` over the code | `docs/` describes intent and past phases. Check the code. `AUDIT.md` and the roadmap are the live trackers |
| 17 | Restarting or rebuilding production while an execution runs | Check for running executions first. A stopped eval script leaves its last execution running on the server; wait for it to end |
| 18 | Running two heavy things at once on a small machine | One reference project at a time (`--parallel 1`). Check free memory before starting; the large default image needs several GB |
| 19 | Watching a long run with a filter that only matches success, or piping the filter through a buffering command | Match failures and the end of the run too. Do not put `cut` or `head` after `grep --line-buffered`; they hold the output back |
| 20 | Rewriting source files with shell or script one-liners | Backslashes in regular expressions and CRLF line endings get corrupted. Edit files with the editor tool, and look at `git diff --stat` afterwards: a small change must be a small diff |
| 21 | Reformatting a file while changing two lines in it | Leave untouched lines alone |
| 22 | Leaving a changelog line, a roadmap row or a test for "later" | They are part of the change. CI fails without the changelog line |
| 23 | Building or committing an environment for the user's project | Environments come from configuration, the project's devcontainer, or approved discovery |
| 24 | Putting vendor calls (GitHub, Trello, a provider SDK) in a service | Extend the adapter interface and call that |
| 25 | Pushing a benchmark's hidden tests to the sandbox repository | They exist only for grading |
| 26 | Reporting "done" from a passing unit test when the change touches Docker, git or a live service | Say exactly what was exercised and what was not |

## 10. Working style

- Read the code involved, and grep every caller of what you change, before editing.
- When there are two reasonable designs, pick one, say why in two sentences, and name what it does not cover.
- Report plainly: lead with the result, give numbers, then what is unproven or risky. A failed bar is reported as failed.
- Ask before anything paid, hard to reverse, or outward-facing (merge, release, production rebuild during work, deleting data). Carry on with everything that does not depend on the answer.
- Keep `scratch/` for launch scripts and logs. Do not create planning or analysis documents unless asked; record decisions in the roadmap row or the changelog instead.
- On Windows: the production stack and evals run from WSL2, long evals should run in their own terminal window rather than a background shell of the coding tool, and `gh` may not be on the Git Bash PATH (call it from PowerShell, with `--body-file` for PR text).

## 11. Checklist before saying a task is done

Run through all of it. Anything skipped is stated in the final message, not left out.

1. `git status` and `git diff --stat`: only the files this task needs, and no file with a diff far larger than the change.
2. `npm run verify` passes (lint, build, all unit tests). Paste the pass count.
3. New logic has a test, and a new test file is in the `test` script list.
4. No language, tool, vendor or file name is hard-coded outside an adapter or the toolchain.
5. No secret is logged, returned by the API, or written to a file that is committed.
6. New environment variable: in `src/config.ts`, in `.env.example`, and in the production check if required.
7. Schema change: a committed migration, no `db push`.
8. Prompt change: a new version file and the bump in `src/prompts/index.ts`.
9. Agent or prompt change: the x3 benchmark was run against an image that contains the change, with the user's approval, and the result is compared with the last recorded x3 run. If not run, say the change is not ready to commit.
10. `CHANGELOG.md` has a line under Unreleased (unless docs only).
11. The roadmap is updated: the limitation row is closed, marked partly fixed with what is left, or a new row is added for a limitation found on the way.
12. This file still matches the code for anything the change touched.
13. Nothing is left running: eval processes, sandbox containers, changed power or system settings.
14. The final message says what changed, what was verified and how, what was not verified, what is still open, and what it cost if anything was paid.
