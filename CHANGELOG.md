# Changelog

All notable changes to Tickwright are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below 1.0.0, a breaking change raises the minor version (0.1 → 0.2) and anything else raises the patch version. Breaking means any of:

- an API request or response changes in a way existing callers notice;
- an environment variable is renamed or removed;
- a database migration needs a manual step;
- a tracker adapter's `revisionHash` formula changes (it is part of the execution idempotency key).

Prompt files keep their own versions (`src/prompts/execution/*.vN.md`).

## [Unreleased]

### Added

- **Test secrets.** `PATCH /api/repositories/:id` accepts `testSecrets` (environment variables for the checks, such as a test-mode API key), stored encrypted. Every check gets them: setup's baseline run, the agent's sandbox and verification. They are never kept in the environment snapshot, are masked in check output, and a change that contains one is rejected. The agent can read them, so they must be test-grade values. Needs the new migration.
- **Limits per repository.** A repository's `executionPolicy` can now set `sandboxCpus` (default 2), `sandboxMemoryMb` (2048), `sandboxMaxProcesses` (256), `checkTimeoutSeconds` (300, for one check or agent command) and `maxFileBytes` (500,000, the largest file the agent may write), and `maxChangedFiles` may go up to 1,000 (before, 100). Unset values keep the earlier fixed limits.
- **Progress of long steps.** While a devcontainer build, setup or a check runs, the execution records a `GRAPH_STEP_PROGRESS` event about once a minute (`EXECUTION_PROGRESS_INTERVAL_SECONDS`) with the step, its command, the elapsed time and the end of its output (secrets masked), so the API shows a run is alive and what it is doing. A step with no new output for `EXECUTION_HUNG_AFTER_SECONDS` (default 600) is marked as possibly hung.
- **Environment sweep.** On start and every hour, the app removes what ended runs left behind (snapshot, containers, network, clone) and repository environment caches and devcontainer builds older than `EXECUTION_SNAPSHOT_MAX_AGE_HOURS` while the repository has no run in progress; only what its own database knows is touched. A run does not start with less than `EXECUTION_MIN_FREE_DISK_GB` (default 10) free after a sweep.
- **Setup secrets.** `PATCH /api/repositories/:id` accepts `setupSecrets` (environment variables such as a private registry token), stored encrypted. Only the setup command gets them; checks, the environment snapshot and the agent never do, and a change that contains one is rejected.
- **Unverified plans are flagged.** The plan comment on the ticket says when nothing will test the change (the repository has no checks) or when checks will only be proposed during the run, and the `PLAN_WRITTEN` event records which applies and the checks that will run.
- **Git submodules.** The clone fetches a repository's submodules at the commit's revisions.
- **Devcontainer builds.** A project whose devcontainer builds a Dockerfile, uses Docker Compose or adds features now runs in the image the official Dev Container CLI builds from it (before setup, with network and without credentials), instead of falling back to the default image. The other Compose services start beside the run as its service containers. Builds that would read files outside the repository are refused and reported.

### Changed

- **The plan is written from the code.** In `tool_loop` mode the plan step now reads the repository with the read-only tools (list, read, search) before it writes the plan, instead of getting the first 20,000 bytes of a few files. Each example now says what the code gives today, worked out from the code, and what it should give after the change ("now 1400; after the change 700"), so a ticket sentence describing the bug is no longer planned as the goal. On the benchmark ticket where half the plans did that, all 10 runs are now correct. Each step is recorded as a `PLAN_STEP` event. A model or reasoning effort configured for `plan` applies to it; `planner` sets one for this mode only.

### Security

- The GitHub token is sent to `https://github.com/` only (before, to any host git contacted during a clone or push), and git may use HTTPS only, so a submodule URL cannot use `file://`, ssh or other transports.

## [0.1.0] - 2026-11-08

First tagged version. It covers roadmap Phases 0–3 and the Phase 4 work done so far.

### Added

- **Ticket to draft pull request.** Trello cards with an eligible label become executions. The agent writes a plan, a person approves it, the agent changes the code in a Docker sandbox, a reviewer checks the diff, a person approves publishing, and a GitHub App opens a draft pull request.
- **Decisions on the ticket.** The agent comments its plan and its change on the card; approvers listed on the connection reply `/approve`, `/reject <reason>` or plan feedback. The same decisions are available through the API.
- **Planning.** The plan step pins the base commit, triages the ticket and writes examples of the expected behaviour and open questions; plans can be revised with feedback.
- **Agent loop with sandbox tools.** The model lists, reads, searches and edits files and runs the repository's checks inside the sandbox, within step, token and output limits, and stops at a finish or a budget.
- **Reviewer.** A separate review step rejects unsafe or unrelated diffs and reruns the agent's tests; only tests that ran count.
- **Any language through the repository's environment.** The sandbox image, setup and checks come from the repository's approved configuration, else its devcontainer, else a universal image, with a discovery step that proposes them for a person to approve once. Tests can run with services such as PostgreSQL.
- **LLM providers as configuration.** Gemini, OpenAI (Chat Completions or Responses API) and Anthropic, plus any OpenAI-compatible endpoint through `LLM_PROVIDERS` profiles. A model and reasoning effort can be set per kind of call, and a daily token limit caps spend.
- **Reliable messaging.** Execution state changes use a transactional outbox and inbox over RabbitMQ, with retry and dead-letter queues.
- **Evaluation.** A coding benchmark with hidden tests across Node, Python, Go and Python with PostgreSQL; a reviewer-only replay; and reference runs on real open-source projects.
- **Security.** Authentication on `/api`, CORS allowlist, rate limiting, encrypted integration and agent credentials redacted from responses, and a production configuration check at boot.
- Apache-2.0 license; GitHub Actions CI running lint, build and unit tests.
- Versioning: this changelog, the version in `GET /health`, and a CI check that a pull request updates the changelog.

### Changed

- The project is renamed from its working name to Tickwright.

### Removed

- The unused agent-to-agent messaging layer and its `Message` table (migration `20261108000000_remove_agent_messages`), an unused work item service, and unused packages (`@google/generative-ai`, `@prisma/extension-accelerate`, `uuid`).

### Fixed

- `POST /api/skills/assign` no longer returns the agent's encrypted API key.
- A failed model listing (`GET /api/llm/models`, `POST /api/llm/discover`) answers 502 `BAD_GATEWAY` with the provider's message instead of a generic 500.
- An MCP resource type without a connector fails with an error instead of returning a simulated success.

[Unreleased]: https://github.com/zack10/tickwright/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zack10/tickwright/releases/tag/v0.1.0
