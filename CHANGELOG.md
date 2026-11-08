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

- **Devcontainer Dockerfiles.** A project whose devcontainer builds a Dockerfile now runs in the image it builds (built as-is before setup, with network and without credentials), instead of falling back to the default image.

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
