<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" alt="Tickwright logo: a try-square forming a check mark" width="96" height="96">
  </picture>
</p>

# Tickwright

Express/TypeScript backend that turns tickets into reviewed code changes. An AI agent picks up a bug card from Trello, plans the fix, edits the code in an isolated Docker workspace, proves it with the repository's own checks, and opens a **draft** GitHub pull request. A human approves both the plan and the exact diff before anything is pushed.

**Quick introduction (76 s):**

https://github.com/user-attachments/assets/ccbb99cc-d576-46e6-b595-151e400c1743

It also runs a simpler general-purpose pipeline: queue a task for an LLM agent and get structured output back.

Built on PostgreSQL + Prisma, RabbitMQ, LangGraph, and pluggable LLM providers (Gemini, Anthropic, and any OpenAI-compatible API by configuration).

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [How the Trello → pull request workflow runs](#how-the-trello--pull-request-workflow-runs)
- [Task pipeline](#task-pipeline)
- [Reliable messaging](#reliable-messaging)
- [Data model](#data-model)
- [Security model](#security-model)
- [Repository environment](#repository-environment)
- [Setting up the Trello → GitHub workflow](#setting-up-the-trello--github-workflow)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Known limits](#known-limits)
- [Project docs](#project-docs)
- [License](#license)

## Quick start

Requirements: Node.js 20 LTS or newer, and Docker Desktop with Compose.

```powershell
Copy-Item .env.example .env.local
# Set ENCRYPTION_KEY (64 hex chars) and provider credentials in .env.local.
# Either set API_AUTH_TOKEN, or AUTH_DISABLED=true for local-only development.
docker-compose up -d            # Postgres on :15432, RabbitMQ on :15673 (UI on :25672)
npm install
npm run prisma:migrate:local
npm run dev:local               # API on http://localhost:3001
```

Check it is up:

```powershell
curl.exe http://localhost:3001/health
# {"status":"healthy","version":"0.1.0","checks":{"database":"ok","rabbitmq":"ok"}}
```

If your database was created earlier with `prisma db push`, `prisma migrate dev` will offer to reset it, which deletes all data. Don't accept. If the schema already matches the init migration, baseline it instead:

```powershell
npx dotenv -e .env.local -- npx prisma migrate resolve --applied 20260620000000_init
npx dotenv -e .env.local -- npx prisma migrate deploy
```

Use migrations (not `db push`) from then on.

## Architecture

One Node process serves the HTTP API and runs the background workers. Work is handed between them through RabbitMQ, and every state change is stored in PostgreSQL first.

Each box links to its source file. (Diagram drafted with [GitDiagram](https://gitdiagram.com/zack10/tickwright).)

```mermaid
flowchart TD

subgraph group_api["API and Projects"]
  node_api["HTTP API<br/>security headers → CORS → auth → rate limit<br/>[index.ts]"]
  node_execution_routes["Execution routes<br/>[executionRoutes.ts]"]
  node_execution_controller["Execution controller"]
  node_project_controller["Project management"]
end

subgraph group_execution["Ticket Execution"]
  node_poller["Integration poller<br/>every 30 s"]
  node_ingestion["Ticket ingestion"]
  node_tracker["Tracker adapters<br/>[trackerRegistry.ts]"]
  node_execution_service["Execution state"]
  node_worker["Execution workers<br/>plan · run · publish<br/>[executionWorker.ts]"]
  node_workspace["Docker workspace<br/>repository image"]
  node_ticket_conversation["Ticket approvals"]
end

subgraph group_llm["LLM and Agents"]
  node_planning["Plan generation<br/>[planning.ts]"]
  node_run_graph["Execution run graph<br/>[executionGraph.ts]"]
  node_sandbox["Agent tools<br/>[tools.ts]"]
  node_llm_service["LLM service<br/>[LLMService.ts]"]
  node_provider_registry["Provider registry<br/>[registry.ts]"]
  node_agent_runner["Task agent<br/>[agentRunner.ts]"]
end

subgraph group_messaging["Queues and State"]
  node_database[("PostgreSQL<br/>[db.ts]")]
  node_outbox["Outbox flusher<br/>every 2 s<br/>[outboxService.ts]"]
  node_task_queue["Task queue"]
end

node_client(("API client / UI"))
node_trello["Trello tracker"]
node_rabbit["RabbitMQ<br/>agent_exchange"]
node_providers["LLM providers<br/>Gemini · Anthropic · OpenAI-compatible"]
node_github["GitHub"]

node_client -->|"HTTPS + Bearer token"| node_api
node_api -->|"routes requests"| node_execution_routes
node_execution_routes -->|"dispatches"| node_execution_controller
node_execution_controller -->|"creates and approves"| node_execution_service
node_execution_controller -->|"syncs tracker"| node_ingestion
node_project_controller -->|"reads and writes"| node_database
node_poller -->|"syncs trackers"| node_ingestion
node_ingestion -->|"selects adapter"| node_tracker
node_tracker -->|"fetches tickets"| node_trello
node_ingestion -->|"upserts work items"| node_database
node_ingestion -->|"creates executions"| node_execution_service
node_execution_service -->|"stores state"| node_database
node_execution_service -->|"records events"| node_outbox
node_outbox -->|"publishes with confirms"| node_rabbit
node_rabbit -->|"dispatches jobs"| node_worker
node_worker -->|"runs planning"| node_planning
node_worker -->|"runs execution"| node_run_graph
node_run_graph -->|"clones and verifies"| node_workspace
node_run_graph -->|"uses tools"| node_sandbox
node_run_graph -.->|"requests model calls"| node_llm_service
node_llm_service -->|"selects provider"| node_provider_registry
node_provider_registry -->|"routes calls"| node_providers
node_worker -->|"handles replies"| node_ticket_conversation
node_ticket_conversation -->|"reads and comments"| node_trello
node_worker -->|"opens draft PR"| node_github
node_worker -->|"stores execution data"| node_database
node_api -->|"queues tasks"| node_task_queue
node_task_queue -->|"runs task agent"| node_agent_runner
node_agent_runner -.->|"requests completions"| node_llm_service
node_task_queue -->|"publishes task"| node_rabbit

click node_api "https://github.com/zack10/tickwright/blob/main/src/index.ts"
click node_execution_routes "https://github.com/zack10/tickwright/blob/main/src/routes/executionRoutes.ts"
click node_execution_controller "https://github.com/zack10/tickwright/blob/main/src/controllers/executionController.ts"
click node_project_controller "https://github.com/zack10/tickwright/blob/main/src/controllers/projectController.ts"
click node_database "https://github.com/zack10/tickwright/blob/main/src/db.ts"
click node_poller "https://github.com/zack10/tickwright/blob/main/src/services/integrationPollingService.ts"
click node_ingestion "https://github.com/zack10/tickwright/blob/main/src/services/ingestionService.ts"
click node_tracker "https://github.com/zack10/tickwright/blob/main/src/integrations/trackerRegistry.ts"
click node_execution_service "https://github.com/zack10/tickwright/blob/main/src/services/executionService.ts"
click node_outbox "https://github.com/zack10/tickwright/blob/main/src/services/outboxService.ts"
click node_worker "https://github.com/zack10/tickwright/blob/main/src/services/executionWorker.ts"
click node_planning "https://github.com/zack10/tickwright/blob/main/src/services/agentGraph/planning.ts"
click node_run_graph "https://github.com/zack10/tickwright/blob/main/src/services/agentGraph/executionGraph.ts"
click node_workspace "https://github.com/zack10/tickwright/blob/main/src/services/workspaceService.ts"
click node_sandbox "https://github.com/zack10/tickwright/blob/main/src/services/sandbox/tools.ts"
click node_llm_service "https://github.com/zack10/tickwright/blob/main/src/services/llm/LLMService.ts"
click node_provider_registry "https://github.com/zack10/tickwright/blob/main/src/services/llm/registry.ts"
click node_ticket_conversation "https://github.com/zack10/tickwright/blob/main/src/services/ticketConversation.ts"
click node_task_queue "https://github.com/zack10/tickwright/blob/main/src/services/taskQueueService.ts"
click node_agent_runner "https://github.com/zack10/tickwright/blob/main/src/services/agentRunner.ts"

classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
classDef toneIndigo fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81
class node_api,node_execution_routes,node_execution_controller,node_project_controller,node_client toneBlue
class node_poller,node_ingestion,node_tracker,node_execution_service,node_worker,node_workspace,node_ticket_conversation toneAmber
class node_planning,node_run_graph,node_sandbox,node_llm_service,node_provider_registry,node_agent_runner toneMint
class node_database,node_outbox,node_task_queue toneRose
class node_trello,node_rabbit,node_providers,node_github toneIndigo
```

| Component | Where | Role |
| --- | --- | --- |
| HTTP API | `src/routes`, `src/controllers`, `src/middleware` | Validates requests with Zod, delegates to services, formats errors via `AppError` |
| Execution state machine | `src/services/executionService.ts` | Creates executions, submits plans, decides approvals; writes outbox events in the same transaction |
| Outbox flusher | `src/services/outboxService.ts` | Publishes pending `OutboxEvent` rows to RabbitMQ |
| Execution workers | `src/services/executionWorker.ts` | Consume `execution.plan`, `execution.run`, `execution.publish`; deduplicate with `InboxReceipt`; hold run leases |
| Run graph | `src/services/agentGraph/` | LangGraph state machine that plans, edits, verifies and reviews a change |
| Workspace | `src/services/workspaceService.ts` | Docker clone, verification, diff, and publish-from-fresh-clone |
| Issue trackers | `src/integrations/trackerRegistry.ts` | Pluggable `IssueTrackerAdapter`s; Trello is the only one |
| Source control | `src/integrations/githubApp.ts` | GitHub App auth, base SHA, draft pull requests |
| LLM layer | `src/services/llm/` | Provider routing, output checks, rate-limit retries |
| Task pipeline | `src/services/taskQueueService.ts`, `agentRunner.ts` | General LLM tasks with retries and leases |

If RabbitMQ is unavailable at startup in non-production, the API still starts in degraded mode (`/health` reports it).

### Where output is written on disk

The two pipelines write to different folders. All three are gitignored.

| Folder | Pipeline | What's in it |
| --- | --- | --- |
| `generated-code/<project>/` | Task pipeline | Files from an agent's `FILE` blocks in a task reply. This is the task's final output. |
| `workspaces/<executionId>/` (`WORKSPACE_ROOT`) | Execution pipeline | A full clone of the target repo where the agent edits files and verification runs. It's a scratch copy, not the output, and is deleted when the run step ends (set `KEEP_WORKSPACES=true` to keep it for debugging). |
| `artifacts/<executionId>.diff` (`ARTIFACT_ROOT`) | Execution pipeline | The exact diff that was verified, reviewed and approved. This is what gets published. |

Publishing never reads `workspaces/`. It clones the repository fresh, applies the `.diff` from `artifacts/`, and pushes, so the PR always contains exactly the approved bytes.

## How the Trello → pull request workflow runs

### End to end

```mermaid
sequenceDiagram
    autonumber
    actor Human as Reviewer
    participant T as Trello
    participant API as API + workers
    participant G as Run graph
    participant D as Docker workspace
    participant L as LLM
    participant GH as GitHub

    API->>T: poll board (or POST /integrations/:id/sync)
    T-->>API: cards with the eligible label
    API->>API: upsert WorkItem, create Execution (idempotent per card revision)
    API->>GH: pin base SHA, clone it
    API->>L: triage (may decline), then the plan with its examples and questions
    API->>API: submit the agent's plan → AWAITING_PLAN_APPROVAL
    API->>T: comment with the plan and how to answer
    loop until approved, rejected or PLAN_MAX_VERSIONS
        Human->>T: reply /approve, /reject <reason>, or feedback
        API->>T: read replies when polling (the API takes the same decisions)
        API->>L: on feedback, a revised plan, commented again
    end
    API->>G: run worker claims execution (lease)
    G->>D: clone the pinned SHA, resolve environment, setup (no token)
    G->>L: file edits following the approved plan
    G->>D: write files, run the repository's checks (network off)
    G->>L: review the diff
    G->>API: store DIFF artifact → AWAITING_PUBLISH_APPROVAL
    API->>T: comment with the changed files, checks and any reviewer objections
    Human->>T: reply /approve or /reject <reason> (or POST /approvals/publish {snapshotHash = diff hash})
    API->>D: fresh clone, git apply approved diff, push branch
    API->>GH: open draft pull request
    API->>T: comment with PR link
```

Both approvals must quote the `snapshotHash` of the pending approval, so a reviewer can only approve exactly what they saw. The publish step re-checks that hash against the stored diff and that the base branch has not moved.

### Deciding on the ticket

The plan step reads the ticket and the repository at a pinned commit and posts the agent's plan on the ticket: what it understood as concrete examples ("given ..., the result is ..."), the readings it is unsure between, the files it expects to change and how it will check them. The run later clones the same commit and follows the approved plan.

People decide by replying on the ticket, or through the API (a frontend is just another client of it):

| Reply on the ticket | API | Effect |
| --- | --- | --- |
| `/approve [note]` | `POST /executions/:id/approvals/plan` `{ approved: true, snapshotHash }` | Plan approved; the note reaches the agent with the plan |
| any other text | `{ approved: false, revise: true, comment, snapshotHash }` | The agent revises the plan with that feedback and posts the next version (at most `PLAN_MAX_VERSIONS`, default 5, then BLOCKED) |
| `/reject [reason]` | `{ approved: false, comment, snapshotHash }` | Execution canceled |

A reply that looks like an unknown command (`/aprove`) gets a hint instead of a revision. On a change waiting to be published, `/approve` opens the draft PR and `/reject [reason]` cancels; other text gets a hint. Only approvers decide: the tracker connection's config lists them (`"approvers": ["trello-username-or-member-id"]`). Without that list, replies are not read at all and only the API decides. Only `/approve` approves, so free text can at worst cost a revised plan. A reply counts once, and only when it was written after the pending approval was requested (replies written while the agent is revising are not read). The agent signs its own comments ("— Agent Orchestrator") and never reads a signed comment as a reply, since locally it posts with the person's Trello token. Replies are read when the tracker is polled (`INTEGRATION_POLL_INTERVAL_MS`).

### Execution states

```mermaid
stateDiagram-v2
    [*] --> INGESTED: card synced
    INGESTED --> PLANNING: plan worker
    PLANNING --> AWAITING_PLAN_APPROVAL: plan submitted
    PLANNING --> BLOCKED: ticket declined
    AWAITING_PLAN_APPROVAL --> PLANNING: feedback (revise)
    AWAITING_PLAN_APPROVAL --> BLOCKED: PLAN_MAX_VERSIONS plans
    AWAITING_PLAN_APPROVAL --> QUEUED: plan approved
    AWAITING_PLAN_APPROVAL --> CANCELED: plan rejected
    QUEUED --> RUNNING: run worker claims lease
    RUNNING --> VERIFYING: edits written
    RUNNING --> QUEUED: transient error / lease expired
    VERIFYING --> QUEUED: transient error / lease expired
    VERIFYING --> AWAITING_PUBLISH_APPROVAL: verified diff (reviewed, or with the reviewer's objections)
    RUNNING --> BLOCKED: 3 failed attempts
    VERIFYING --> BLOCKED: 3 failed attempts
    AWAITING_PUBLISH_APPROVAL --> PUBLISHING: diff approved
    AWAITING_PUBLISH_APPROVAL --> CANCELED: diff rejected
    PUBLISHING --> COMPLETED: draft PR opened
    COMPLETED --> [*]
    BLOCKED --> [*]
    CANCELED --> [*]
    FAILED --> [*]
    note right of FAILED
        Any non-final state moves to FAILED
        when retries are exhausted or the
        error is non-retryable (lastError is set).
    end note
```

- A server works on `EXECUTION_RUN_CONCURRENCY` runs and `EXECUTION_PLAN_CONCURRENCY` plan steps at once (default 1 each). Runs hold a lease (`EXECUTION_LEASE_MS`) renewed by a heartbeat. If a worker dies, a sweep requeues the run once the lease expires.
- A requeued run resumes from its last completed graph step (`GraphCheckpoint`), not from the clone. A failed model call is retried with backoff before it fails the step.
- Transient failures are retried; a moved base branch, a changed diff, exhausted LLM credits or a long quota wait fail immediately.
- Trello gets a comment on plan, block, failure and PR creation, and when a change reaches publish approval with the reviewer's objections.

### Inside a run

The run step is a LangGraph state graph (`src/services/agentGraph/executionGraph.ts`). Each change gets up to 3 attempts; feedback from a failed attempt is fed into the next one. A retry normally starts from a clean checkout of the base commit, so it never builds on a failed attempt's edits. The exception is a `tool_loop` attempt that ran out of its share of tokens or time part-way: the next attempt continues from its changes.

```mermaid
flowchart TD
    start([start]) --> load["load_context<br/>agent, plan task, base SHA, clone workspace,<br/>environment (configured, devcontainer or discovered),<br/>setup + baseline checks"]
    load --> inspect["inspect_repo<br/>file tree, relevant files"]
    inspect --> triage["triage_ticket<br/>LLM: can this ticket be done here?"]
    triage -->|declined| blocked
    triage -->|proceed| plan["plan_change<br/>LLM: internal plan"]
    plan -->|single_shot| impl["implement_change<br/>LLM: FILE blocks"]
    plan -->|tool_loop| loop["agent_loop<br/>LLM + sandbox tools until finish"]
    impl -->|output parsed| policy["enforce_policy<br/>file count, protected paths"]
    impl -->|malformed output| impl
    impl -->|3rd malformed output| blocked
    loop -->|finished with changes| policy
    loop -->|no changes, out of steps or budget share| analyze
    loop -->|declined, execution budget spent, 3rd failure| blocked
    policy -->|violation| analyze
    policy -->|allowed| verify["verify_change<br/>repository's checks in Docker, network off"]
    verify -->|pass| review["review_diff<br/>secret patterns, then LLM review<br/>(tool_loop: code-reading reviewer)"]
    verify -->|fail| analyze["analyze_failure<br/>LLM: guidance for next attempt"]
    review -->|objections or secret found, attempts left| analyze
    review -->|approved| artifact["create_diff_artifact<br/>DIFF + PUBLISH approval"]
    review -->|objections, last attempt| artifact
    analyze -->|attempts left| impl
    analyze -->|attempts left, tool_loop| loop
    analyze -->|none left| blocked(["block_execution<br/>BLOCKED"])
    verify -->|3rd failure| blocked
    review -->|secret found, 3rd attempt| blocked
    policy -->|3rd violation| blocked
    artifact --> done(["AWAITING_PUBLISH_APPROVAL"])
```

`EXECUTION_AGENT_MODE` picks how the change is made:

- `single_shot` (default): `implement_change` asks the model once per attempt for whole files.
- `tool_loop`: `agent_loop` gives the model the sandbox tools (`src/services/sandbox/tools.ts`): `list_files`, `read_file`, `search_code`, `edit_file`, `run_check`, `run_command`, `skip_reproduction` and `finish`. It works step by step against a long-lived container with no network, until it calls `finish` or a budget runs out: `AGENT_MAX_STEPS` model calls per attempt (or the execution's `budget.maxSteps`), the execution's `budget.maxTokens` across all attempts, and its `budget.maxDurationSeconds`. The agent can also decline the ticket (`finish` with status `blocked`), which blocks the execution without retrying. Each model call is a `GRAPH_AGENT_STEP` event and each tool call a `ToolCall` row, so a run can be replayed.
  - The tools enforce the rules, not only the prompt: protected paths can't be edited, existing test files can't be changed (new ones can), and code can change only after a new test has failed or the agent has said with `skip_reproduction` why no test can show the change.
  - Old tool results are shortened in batches, so the start of the conversation stays the same and the provider's prompt cache keeps working.
  - Check and command output is capped at 10,000 characters with the start and the end kept, and `read_file` returns up to 400 lines per call. A repository can set `executionPolicy.maxToolOutputChars` (1,000-20,000) and `executionPolicy.maxReadLines` (50-400).
  - Setup may run for 15 minutes; a repository can set `executionPolicy.setupTimeoutSeconds` (60-7,200).
  - The agent gets 30 model calls per attempt and a run 30 minutes; a repository can set `executionPolicy.maxAgentSteps` (5-200) and `executionPolicy.maxRunSeconds` (300-14,400).

In both modes, policy, verification and review run afterwards, independently of what the agent reports.

#### The reviewer advises, a person decides

In `tool_loop` mode the reviewer reads the code with read-only tools (`list_files`, `read_file`, `search_code`) and answers a fixed checklist: does the diff change the code that produces the wrong behaviour, is every name it adds used by the existing code, do the new tests call the existing code, does the ticket's example work. Our code makes the decision from the answers, so a reviewer that finds a problem can't still approve.

A test counts as evidence only if verification ran it. The command whose failure showed the problem (the agent's own new test) becomes a check that verification runs again on the finished change, and the reviewer gets the list of what verification ran: a new test file that no check runs proves nothing, however well it is written.

An objection goes back to the next attempt as feedback. If the reviewer still objects after the last attempt, the verified change is not thrown away. It goes to publish approval with the objections attached, and they appear at the top of the Trello comment and the draft PR description. Only the automatic secret check blocks a change outright. Suggestions that don't reject the change are shown with it.

#### Choosing models and reasoning per call

An agent can set a model and a reasoning effort for each kind of call, keyed by prompt name (`triage`, `plan`, `agent`, `analyze`, `review`, `reviewer`, `discover`, `implement`). Anything unset uses the agent's own model and the model's default effort.

```json
{
  "config": {
    "models": { "triage": { "provider": "openai", "model": "gpt-5-nano" } },
    "reasoningEffort": { "triage": "low", "plan": "low", "analyze": "low" }
  }
}
```

- `models` generalises the older `config.reviewer`, which still works as `models.review` and `models.reviewer`. A model of the agent's provider without its own `apiKey` uses the agent's key. Keys are encrypted and redacted like the agent's.
- `reasoningEffort` (`low`, `medium` or `high`) is sent to OpenAI-compatible APIs as `reasoning_effort`, and only when set, because models without reasoning reject it. Gemini ignores it for now; Anthropic's extended thinking is off already.
- A misspelt call kind or an unknown level is refused when the agent is saved.

#### Token limits

Every model call, from either pipeline, is recorded in the `LlmUsage` table with its tokens (input, of which read from the provider's cache, and output, of which reasoning) and what it was for (`plan.v3`, `agent.v6`, `task`, ...). `GET /api/executions/:id` returns them per model as `usage`. Two limits are checked before each call:

- **Per execution:** `budget.maxTokens` on the execution (set from `EXECUTION_MAX_TOKENS` when it is created, default 200,000) covers all of its calls: plan, loop, review and failure analysis.
- **Per day, across everything:** `LLM_DAILY_TOKEN_LIMIT` (default 2,000,000 per UTC day, `0` to switch off). Once reached, new calls fail with a `TokenLimitError` that is not retried, and the execution fails with the reason. `GET /api/llm/usage/today` returns `{ used, limit, resetsAt }`.

A call that has started always finishes, so a limit can be passed by one call.

The LLM steps' prompts are versioned files in `src/prompts/execution/` (e.g. `implement.v1.md`). Each has a system part (fixed instructions) and a user part (ticket details). The active versions are listed in `src/prompts/index.ts`, and each run records them in its execution events (`promptVersions`, `promptVersion`). To change wording, add a new version instead of editing a released one.

The agent returns whole files in this format inside a JSON `actions` string; anything else is rejected and retried:

````text
FILE: src/pricing.js
```js
...complete new file content...
```
````

## Task pipeline

The original, general-purpose pipeline: run one LLM agent on a payload and store its structured result.

```mermaid
sequenceDiagram
    participant C as Client
    participant API
    participant DB as PostgreSQL
    participant MQ as RabbitMQ
    participant W as Task worker
    participant L as LLM

    C->>API: POST /api/tasks (Idempotency-Key)
    API->>DB: insert Task (PENDING), or return existing for the same key
    API->>MQ: publish task id (publisher confirms)
    API-->>C: 202 Accepted
    MQ->>W: deliver task id
    W->>DB: claim (PENDING → IN_PROGRESS, lease)
    W->>L: prompt built from agent, project and payload
    L-->>W: structured JSON output
    W->>DB: COMPLETED / FAILED, result, project context updates
    Note over W,MQ: failures wait in a delayed retry queue, up to TASK_MAX_ATTEMPTS
    C->>API: GET /api/tasks/:id
```

Generated files are written only under `generated-code/<project>/`, with file-count and size limits. A periodic sweep re-queues pending tasks and expired leases.

## Reliable messaging

Execution state changes are never published straight to RabbitMQ. They are written as `OutboxEvent` rows in the same database transaction, then flushed. Consumers record an `InboxReceipt` per message, so a redelivered message is processed once.

```mermaid
flowchart LR
    tx["Service transaction<br/>state change + OutboxEvent"] --> db[(PostgreSQL)]
    db --> flusher["Outbox flusher"]
    flusher -->|publisher confirms| ex[["agent_exchange"]]
    ex --> q["execution_run"]
    q --> consumer["Consumer<br/>skip if InboxReceipt exists"]
    consumer -->|success| receipt["write InboxReceipt, ack"]
    consumer -->|retryable error| retry["execution_run.retry<br/>waits CONSUMER_RETRY_DELAY_MS"]
    retry -->|TTL expires| q
    consumer -->|NonRetryableError or<br/>CONSUMER_MAX_ATTEMPTS reached| dead["execution_run.dead"]
    dead --> fail["Execution → FAILED<br/>with lastError"]
```

The same pattern applies to `execution_plan` and `execution_publish`. Inspect the `*.dead` queues in the RabbitMQ management UI (`http://localhost:25672`). In code, throw `NonRetryableError` (`src/utils/safeError.ts`) for failures that will not succeed on retry.

## Data model

Core entities (see `prisma/schema.prisma` for every field):

```mermaid
erDiagram
    Project ||--o{ Agent : has
    Project ||--o{ Repository : has
    Project ||--o{ IntegrationConnection : has
    Project ||--o{ WorkItem : has
    Project ||--o{ Execution : has
    Project ||--o{ Task : has
    Agent ||--o{ Task : runs
    Agent }o--o{ Skill : assigned
    WorkItem ||--o{ Execution : "one per revision"
    Repository ||--o{ Execution : targets
    Execution ||--o{ Plan : versions
    Plan ||--o{ PlanTask : contains
    PlanTask ||--o{ TaskAttempt : tries
    TaskAttempt ||--o{ ToolCall : "agent and reviewer tool calls"
    Execution ||--o{ Approval : gates
    Execution ||--o{ Artifact : produces
    Execution ||--o{ ExecutionEvent : "audit log"
    Execution ||--o{ LlmUsage : "tokens per model call"
```

`OutboxEvent` and `InboxReceipt` stand alone and back the messaging guarantees above. `GraphCheckpoint` stores the run graph's state after each step, so a requeued run resumes where it stopped. `LlmUsage` rows from the task pipeline carry a task id instead of an execution id. An execution's idempotency key is `workItemId:revisionHash`, so re-syncing an unchanged card never creates a second execution.

## Security model

**API access**
- All `/api/*` routes require `Authorization: Bearer <API_AUTH_TOKEN>`. Auth is skipped only when `AUTH_DISABLED=true` is set explicitly (refused in production); otherwise missing tokens get `401`.
- `GET /health` is intentionally unauthenticated for platform probes.
- Browsers are allowed only from origins in `CORS_ORIGINS`; an empty list blocks all browser origins.
- Production refuses to start without `API_AUTH_TOKEN`, `CORS_ORIGINS`, `DATABASE_URL` and `ENCRYPTION_KEY`.

**Secrets**
- Agent API keys (`config.apiKey`, and those in `config.reviewer` and `config.models`) and integration credentials are encrypted at rest (`ENCRYPTION_KEY`) and redacted from API responses.
- Logged errors omit query strings and headers (`describeError()`), so provider keys and tokens are not written to logs.
- Raw LLM output is not stored unless `STORE_RAW_LLM_OUTPUT=true`.

**Repository execution**
- Verification runs in the repository's image with `--network none` and CPU/memory/PID limits. Only the setup step has network, and it never gets the GitHub token.
- Generated file writes reject `.git` paths and any path through a symlink.
- Diff review rejects added secrets (GitHub, OpenAI, AWS, Google, Slack tokens, credentials in URLs).
- Publishing never pushes the verification workspace: it clones fresh at the recorded base SHA, applies only the approved diff, and commits and pushes with git hooks disabled.
- The GitHub token travels as an HTTP header from the container's environment. It never appears in `.git/config` or on the docker command line.
- Only **draft** pull requests are created. Nothing is merged or deployed.

**Outbound HTTP**
- HTTP connector calls are denied unless the hostname is in `MCP_HTTP_ALLOWED_HOSTS`. Redirects and URL credentials are rejected. Private IPs also need `MCP_HTTP_ALLOW_PRIVATE_IPS=true`.

**LLM output**
- Responses that hit `LLM_MAX_OUTPUT_TOKENS`, are blocked, or are empty raise an error instead of being parsed as partial output.

## Repository environment

There is no list of supported languages: any language, framework or platform works, the way it does for GitHub Copilot's coding agent or OpenAI Codex. Each repository has an environment (an image, a setup command and named checks), taken in this order:

1. **The repository's configuration** (`verificationConfig.toolchain`, set with `POST` or `PATCH /api/repositories`).
2. **The project's own devcontainer** (`.devcontainer/devcontainer.json` or `.devcontainer.json`): its `image`, `containerEnv`/`remoteEnv`, and its `onCreateCommand`, `updateContentCommand` and `postCreateCommand` as setup. Devcontainers that build a Dockerfile, use Docker Compose or add features aren't supported yet; what was skipped is reported.
3. **The default image**, `EXECUTION_DEFAULT_IMAGE` (`mcr.microsoft.com/devcontainers/universal:6.1.12`, GitHub Codespaces' default, Ubuntu 24.04 with the common languages installed: Java, Maven, Gradle, Python, Node, Go, .NET, PHP, Ruby). Pinned by digest; about 15 GB on disk, downloaded once per server. It has no Rust toolchain: a Rust repository needs its own image.

We never write an environment into the user's project. What was used, and why, is recorded as a `GRAPH_TOOLCHAIN_RESOLVED` event.

**Discovery, approved once.** A repository needs no configuration to start. When it has no configured checks, the agent reads what the project says about itself (README, contributing and agent instruction files, CI configuration, build and dependency files) and proposes a setup command, the checks and, when they need them, environment variables (setup and the checks are separate commands, so a variable they all need, such as which installed runtime to use, goes in the toolchain's `env`). The image is not its choice: it is the devcontainer's or the configuration's, else the default universal image, which already has the common runtimes and build tools; setup installs whatever else the project needs, as Copilot's coding agent and Codex do. A proposal that already failed is never tried again. The proposal is proved by running setup and the checks on the unmodified code; a setup that fails, or a check that can't run, goes back to the agent with its output to revise (up to `EXECUTION_DISCOVERY_MAX_ATTEMPTS`, default 3; `0` turns discovery off). A check that runs but fails on the project's own tests still proves the environment. The run then uses it, and its draft PR says the checks were proposed by the agent and not approved yet. The proposal is stored on the repository (`environmentProposal`), and later runs prove it again instead of asking the model. A person approves it once:

```http
POST /api/repositories/:id/environment/approve
{ "proposalHash": "<environmentProposal.hash>" }
```

It then becomes the repository's `verificationConfig.toolchain`, and every later run uses its checks as fixed checks. If no proposal works, the run uses the default image with no checks and its PR is marked **Unverified**. Each discovery is recorded as a `GRAPH_ENVIRONMENT_DISCOVERED` event with every proposal tried and how it did.

```json
{
  "scripts": ["test"],
  "toolchain": {
    "image": "maven:3.9-eclipse-temurin-21",
    "setup": ["mvn", "-B", "-q", "dependency:resolve"],
    "checks": { "build": ["mvn", "-B", "-q", "-DskipTests", "package"], "test": ["mvn", "-B", "-q", "test"] },
    "protectedPaths": ["pom.xml", ".github"]
  }
}
```

- `setup` runs once after cloning, with network but never the GitHub token. Then each check runs once on the unmodified code, still with network, so whatever a tool only downloads when it really runs (test providers, plugins, modules) is there later. Those results are recorded as the baseline (`GRAPH_BASELINE_CHECKED`). Checks need no offline flags: later runs simply have no network.
- `checks` run with no network (only the repository's `services`, if any), after the agent finishes, and decide whether the change passes. `scripts` picks which ones run; a name with no check is reported as "not available", not as a failure.
- After that, the container is saved as a snapshot image (`docker commit`), and checks and the agent's sandbox run from it. Whatever setup installed outside the repository (`~/.m2`, `~/.cache/pip`, system packages) is kept without knowing any tool. The snapshot is deleted with the workspace.
- The snapshot is also kept as the repository's cache (`agent-cache-<repository>:<environment hash>`) for `EXECUTION_SNAPSHOT_MAX_AGE_HOURS` (default 24; `0` turns it off), as Codex caches its containers. Later runs start from it and run setup again with network, so changed dependencies are still installed but nothing already there is downloaded again. A changed environment uses a new cache; an expired one is rebuilt from the image. Caches are never shared between repositories.
- Files a check creates (`__pycache__`, `target/`, coverage) are never part of the change either.
- A check that already failed on the unmodified code (a test broken by the environment, or a flaky one) doesn't block the change if it fails again, as with Copilot's or Codex's agents: it still runs, the agent is told it was failing before, and the draft PR and the ticket comment say so. A check that passed before and fails after still blocks. An already-failing check can't show new breakage inside it, so the reviewer and the approver decide.
- `services` are containers the checks need, such as a database or a cache: `"services": [{ "name": "db", "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "test" }, "ready": ["pg_isready", "-U", "postgres"] }]` (up to 5). Each run starts its own on a private Docker network (`--internal`) shared only with its setup, checks and sandbox, which reach each one by `name` (here host `db`); nothing on that network reaches the internet. `ready` runs inside the service until it succeeds (within `readyTimeoutSeconds`, default 120) before anything uses it. They are removed, with their volumes, together with the workspace. Discovery is told about them but does not propose them; a person declares them.
- `testFilePatterns` (regular expressions) replace the default conventions (`tests/`, `*.test.*`, `*_test.*`, `test_*`, `*Test.*`, ...). Existing tests may not be edited; new ones may.
- `protectedPaths` default to CI and devcontainer files.

## Setting up the Trello → GitHub workflow

1. **GitHub App**: create one with *Contents* and *Pull requests* read/write, install it on the target repository, and set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM on one line with `\n`).
2. **Repository record**: `POST /api/repositories` with owner, name and installation ID. Its environment can be set in `verificationConfig`, or left to discovery and approved once (see [Repository environment](#repository-environment)).
3. **Trello integration**: `POST /api/integrations` with `type: "TRELLO"` and config `apiKey`, `token`, `boardId`, `eligibleLabel`, `repositoryId`.
4. **Agent**: `POST /api/agents` in the same project with `provider`, `model` and `config.apiKey`. The run uses the project's first agent.
5. Label a card, then wait for the poller or call `POST /api/integrations/:id/sync`.
6. Approve the plan and then the diff:

```json
{ "approved": true, "snapshotHash": "<64-char hex from the pending approval>", "comment": "optional" }
```

Take `snapshotHash` from the pending approval in `GET /api/executions/:id`. A mismatched hash, or an approval that was already decided, returns `409`.

Docker Desktop must be running before an approved plan can execute. The repository can be in any language: its environment and checks come from its configuration, its devcontainer or discovery (see [Repository environment](#repository-environment)).

## API reference

All routes are under `/api` and require the bearer token.

| Area | Endpoints |
| --- | --- |
| Projects | `POST/GET /projects`, `GET/PATCH/DELETE /projects/:id` |
| Agents | `POST/GET /agents`, `GET/PUT/DELETE /agents/:id` |
| Skills | `POST/GET /skills`, `GET/PUT/DELETE /skills/:id`, `POST /skills/assign` |
| Tasks | `POST /tasks` (202, `Idempotency-Key`), `GET /tasks`, `GET /tasks/:id` |
| LLM | `GET /llm/providers`, `POST /llm/discover`, `GET /llm/models` (`X-Provider-Api-Key`), `GET /llm/usage`, `GET /llm/usage/today` (tokens used today against `LLM_DAILY_TOKEN_LIMIT`) |
| Repositories | `POST/GET /repositories`, `PATCH /repositories/:id` (environment, policy), `POST /repositories/:id/environment/approve` (approve a discovered environment) |
| Integrations | `POST/GET /integrations`, `POST /integrations/:id/sync` |
| Work items | `GET /work-items`, `GET /work-items/:id` |
| Executions | `POST/GET /executions`, `GET /executions/:id`, `POST /executions/:id/plans`, `POST /executions/:id/approvals/plan\|publish` |

Behaviour worth knowing:
- Task creation returns `202 Accepted`; execution is asynchronous. Send a stable `Idempotency-Key` so client retries don't duplicate work.
- `POST /llm/discover` takes temporary credentials in the body; `GET /llm/models` takes them in `X-Provider-Api-Key`, never the URL.
- `/llm/usage` returns `501` when the provider has no safe usage API. It never runs paid inference as a probe.
- Syncing an integration that is not an issue tracker (e.g. `GITHUB`) returns `400`.

## Configuration

`.env.example` is the template; `.env.local` (Docker) and `.env.cloud` (Prisma Accelerate) are loaded by the `dev:*` scripts.

| Group | Variables |
| --- | --- |
| Core | `NODE_ENV`, `PORT`, `DATABASE_URL`, `RABBITMQ_URL`, `ENCRYPTION_KEY` |
| API access | `API_AUTH_TOKEN`, `API_AUTH_ACTOR`, `AUTH_DISABLED`, `CORS_ORIGINS`, `API_RATE_LIMIT_PER_MINUTE` |
| LLM | `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `LLM_PROVIDERS`, `LLM_DEFAULT_PROVIDER`, `LLM_DEFAULT_MODEL`, `LLM_DAILY_TOKEN_LIMIT`, `LLM_REQUEST_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_RATE_LIMIT_RETRIES`, `OPENAI_TOOLS_API` |
| Task pipeline | `TASK_MAX_ATTEMPTS`, `TASK_RETRY_DELAY_MS`, `TASK_LEASE_MS`, `GENERATED_CODE_MAX_FILES`, `GENERATED_CODE_MAX_FILE_BYTES`, `STORE_RAW_LLM_OUTPUT` |
| Execution pipeline | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `INTEGRATION_POLL_INTERVAL_MS`, `EXECUTION_LEASE_MS`, `EXECUTION_RUN_CONCURRENCY`, `EXECUTION_PLAN_CONCURRENCY`, `PLAN_MAX_VERSIONS`, `EXECUTION_AGENT_MODE`, `AGENT_MAX_STEPS`, `EXECUTION_MAX_TOKENS`, `EXECUTION_MAX_DURATION_SECONDS`, `WORKSPACE_ROOT`, `KEEP_WORKSPACES`, `ARTIFACT_ROOT` |
| Messaging | `CONSUMER_MAX_ATTEMPTS`, `CONSUMER_RETRY_DELAY_MS` |
| HTTP connector | `MCP_HTTP_ALLOWED_HOSTS`, `MCP_HTTP_ALLOW_PRIVATE_IPS`, `MCP_HTTP_TIMEOUT_MS`, `MCP_HTTP_MAX_RESPONSE_BYTES` |

Defaults and comments are in `.env.example`; `src/config.ts` is the single place they are read.

### Adding an LLM provider

Built in: `gemini` and `anthropic` (native APIs) and `openai`. Any other API that speaks OpenAI's `/models` and `/chat/completions` format (Groq, Mistral, DeepSeek, xAI, Together, Fireworks, OpenRouter, a LiteLLM proxy, or local Ollama / vLLM / LM Studio) is added with configuration only, as a profile in `LLM_PROVIDERS`:

```bash
LLM_PROVIDERS='[
  {"key": "groq", "label": "Groq", "baseUrl": "https://api.groq.com/openai/v1", "apiKeyEnv": "GROQ_API_KEY", "supportsTools": true},
  {"key": "ollama", "baseUrl": "http://localhost:11434/v1"}
]'
GROQ_API_KEY=...
```

Agents then use `"provider": "groq"` with a `model` the endpoint offers (`GET /api/llm/models?provider=groq`). `GET /api/llm/providers` lists every configured provider.

| Field | Meaning |
| --- | --- |
| `key` | Name agents use; lowercase letters, digits, dashes; must not clash with a built-in |
| `baseUrl` | API root. `https` only; `http` is allowed for `localhost` outside production |
| `apiKeyEnv` | Environment variable holding the server's key. Omit for keyless local servers or when each agent sets `config.apiKey` |
| `supportsTools` | Whether the endpoint supports tool calling (default `false`) |
| `toolsApi` | `chat` (default) for Chat Completions, or `responses` for the OpenAI Responses API |
| `modelPrefixes` | Optional: list only models whose id starts with one of these |
| `label` | Optional display name used in errors and model lists |

The server refuses to start if a profile is invalid (bad URL, duplicate key, `apiKeyEnv` not set). Base URLs come only from this configuration: an agent chooses a provider key, never a host, so it cannot make the server send a key elsewhere.

An agent without a `provider` uses `LLM_DEFAULT_PROVIDER` and `LLM_DEFAULT_MODEL` (default `gemini` / `gemini-flash-latest`); an agent with a provider but no model fails with a clear error. APIs with their own format (e.g. AWS Bedrock, Vertex AI) still need a native provider class in `src/services/llm/providers/`.

The built-in OpenAI provider makes tool calls through the Responses API (`OPENAI_TOOLS_API=responses`, the default). It keeps the model's reasoning from one step to the next, sent back encrypted with `store: false`, so nothing is kept at OpenAI; newer models such as `gpt-5.6-luna` refuse tools with reasoning on Chat Completions. `OPENAI_TOOLS_API=chat` goes back to Chat Completions.

## Testing

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint |
| `npm test` | Build, then unit tests (`node:test` against compiled `dist/`) |
| `npm run verify` | Lint + unit tests |
| `npm run test:e2e` | End-to-end suites against a running server |
| `npm run test:e2e:smoke` | Only the credential-free smoke suite |
| `npm run eval:coding` | Coding benchmark: how well the agent fixes real bugs (see below) |
| `npm run eval:reference` | Real issues from real projects in other languages, graded like Multi-SWE-bench (see below) |
| `npm run eval:reviewer` | Replays stored approved diffs through the reviewer alone, graded by the hidden tests (`--model` to compare models, `--grade-only` for no model calls) |

Run a single unit test file with `npm run build && node --test tests/auditFixes.test.js`. New test files must be added to the `test` script in `package.json`.

### End-to-end tests

`tests/e2e/` drives a **running** server over HTTP (start it with `npm run dev:local` first). Copy `.env.e2e.example` to `.env.e2e` and fill in what you have. Each suite skips itself, naming the missing variables, until its credentials are set:

| Suite | Needs | Covers |
| --- | --- | --- |
| `smoke` | server only | health, auth, validation, 404s, project lifecycle, non-tracker sync refused |
| `taskPipeline` | `E2E_LLM_*` | agent key redaction, `Idempotency-Key`, queued task runs to `COMPLETED` |
| `executionPipeline` | `E2E_LLM_*`, `E2E_TRELLO_*`, `E2E_GITHUB_*` (server also needs the GitHub App and Docker) | Trello card → sync → plan approval (stale hash rejected) → run → diff bound to publish approval → draft PR → Trello comment |

The execution suite creates a real Trello card and, unless `E2E_PUBLISH=false`, opens a draft PR, so point it at a throwaway repository. It deletes the card afterwards and, when `E2E_GITHUB_TOKEN` is set, closes the PR and deletes the branch (`E2E_KEEP_RESOURCES=true` keeps them). It reuses one `e2e-execution-pipeline` project between runs.

### Coding benchmark

The e2e suites prove the plumbing works; the benchmark measures whether the agent writes **correct** code. `tests/e2e/coding-scenarios/` holds one suite per language: a small clean project (`repo/`), the environment it runs with and how it is graded (`suite.json`), and scenarios, each with a ticket, the files that plant its bug, and **hidden tests** that never leave this repository. Adding a language is a new suite folder, not a code change.

Node (`node/`, `node:test`):

| # | Scenario | Measures |
| --- | --- | --- |
| 01 | Off-by-one in pagination | Basic single-file fix |
| 02 | Order total rounded down | Numeric edge cases |
| 03 | `slugify` breaks on accents and padding | Edge-case handling |
| 04 | Missing `await` | Async reasoning |
| 05 | Currency ignored by invoice and money helper | Multi-file change |
| 06 | Vague "contacts missing after import" ticket | Finding the right file |
| 07 | Bug in a 30 KB file | The 20 KB context cut-off |
| 08 | Impossible "send invoices to LegacyBill" ticket | Should end `BLOCKED` |

Python (`python/`, `unittest`) and Go (`go/`, `go test`), standard library only:

| # | Python | Go | Measures |
| --- | --- | --- | --- |
| 01 | Discount tiers miss their minimum | `Truncate` cuts accented characters | Basic single-file fix |
| 02 | Invoice totals a few cents off (`money` and `invoice`) | Negative amounts parsed and printed wrong (`Parse` and `Format`) | Multi-file change |
| 03 | Vague "reorder list is missing things" | Vague "nightly job ran several times after downtime" | Finding the cause from a symptom |
| 04 | | Go 03 without its worked example | A ticket with two readings: the approved plan shows which one the agent took |

Python with PostgreSQL (`python-db/`, `unittest` against a real database started as a service):

| # | Scenario | Measures |
| --- | --- | --- |
| 01 | Orders from the last day of a range are missing | Single-file fix in a SQL query |
| 02 | Revenue report shows the wrong amounts | Two files, one of them SQL |
| 03 | Vague "customer order counts are missing people" | Finding the cause (a join) from a symptom |

Per run, the runner points the sandbox repo's `main` at the scenario's code, creates the Trello card, approves the plan, waits for a diff or `BLOCKED`, **rejects publishing** (no PR is opened), and grades the diff in a network-less Docker container: the repo's own tests, then the hidden tests, in the suite's grader image. Outcomes are *correct fix*, *wrong fix shipped* (a PR would have been opened with no warning but the hidden test fails, which is the key number), *wrong fix, reviewer objected* (the same, but the approver saw the reviewer's objections; the run also checks that the objections comment reached the Trello card), *correctly blocked*, *no fix* and *infrastructure failure*. Hidden tests check only what the ticket asks for, as in SWE-bench Verified. Each run's tokens, cache share and cost are in the report when `E2E_PRICE_PER_MTOK` is set ("input,cached,output" per million tokens, or per model: `gpt-5-mini=0.25,0.025,2;gpt-5-nano=0.05,0.005,0.4`); `E2E_REASONING_EFFORT` and `E2E_CALL_MODELS` set the agent's `reasoningEffort` and `models`. It writes `docs/testing/coding-eval-<date>.md`, prints a row for the roadmap's results log, and restores `main` to the clean project.

```bash
npm run eval:coding -- --check            # setup check, no LLM calls
npm run eval:coding -- --scenario python  # one suite (node, python, python-db, go)
npm run eval:coding -- --scenario node/01  # one scenario ("01" alone is 01 of every suite)
npm run eval:coding -- --runs 3           # every scenario, 3 runs each
npm run eval:coding -- --parallel 4       # 4 runs at once: E2E_GITHUB_EXTRA_REPOS has 3 more sandbox repos, the server EXECUTION_RUN_CONCURRENCY=4
```

It needs the execution suite's variables plus `E2E_GITHUB_TOKEN` (Contents read/write on the sandbox repo), the server and Docker on the same machine (it reads the diff artifact from disk), and **it rewrites the sandbox repo's `main`**. `npm test` includes `tests/codingScenarios.test.js`, which checks every scenario is fair in its grader image (so it needs Docker, and is skipped without it): the clean project passes everything, and each bug passes the repo's tests but fails its hidden test by an assertion. Each suite runs with the environment in its `suite.json`; `E2E_ENVIRONMENT` replaces it for every suite.

The benchmark runs on `gpt-5.6-luna` (`E2E_LLM_MODEL` in `.env.e2e`). Its baseline (2026-11-07, every scenario 3 times): 50 correct fixes out of 54, 3 tickets correctly declined, no wrong fix shipped and 1 flagged by the reviewer, for $0.42. Every run is in the results log of `docs/plans/AGENTIC_ROADMAP.md`, with reports in `docs/testing/`.

### Reference projects

`npm run eval:reference` runs real issues from real projects through the whole pipeline: Java (gson), Go (go-zero), Rust (fd), TypeScript (darkreader), JavaScript (dayjs), C (jq) and C++ (Catch2), listed in `tests/e2e/reference-projects/projects.json`. No environment is configured: discovery finds it. The diff is graded the way Multi-SWE-bench grades it, in the project's own image without network, with the instance's tests added. `--runs N` repeats each project (a conclusion needs at least 10), `--ticket clarified` uses a clearer rewrite of the issue, `--publish` opens the draft PR. Like the benchmark, it rewrites the sandbox repo's `main`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `prisma migrate dev` wants to reset the `public` schema | The DB was created with `db push`. Baseline it (see [Quick start](#quick-start)); don't reset. |
| `/health` shows `rabbitmq: error` | Compose isn't running, or another service holds the port. `docker-compose up -d`; AMQP is remapped to `15673` to avoid Windows conflicts. |
| Every request returns `401` | No `API_AUTH_TOKEN` configured. Set it, or `AUTH_DISABLED=true` locally. |
| Execution `FAILED` with a Docker error | Docker Desktop isn't running, or the image pull failed. The error includes the exit code and stderr/stdout tails. |
| Execution `FAILED` with an LLM `429` | Rate limit or quota. Short limits are retried automatically; "no credits" or a daily free-tier quota fail fast. Add credits, wait for the reset, or switch model (free-tier quotas are per model). |
| Execution `BLOCKED` | Three attempts failed verification or review. `GET /api/executions/:id` shows each attempt's error and the events. |
| Approval returns `409` | The `snapshotHash` is stale or the approval was already decided. Re-read the execution and use the pending approval's hash. |
| A message never seems to run | Check the `*.dead` queues in the RabbitMQ UI and the execution's `lastError`. |

## Project structure

```text
src/
  index.ts              app wiring, background loops, graceful shutdown
  config.ts             all env-derived settings
  db.ts                 Prisma client (driver adapter or Accelerate)
  routes/ controllers/  HTTP layer
  middleware/           auth, CORS errors, rate limit, validation, error handler
  schemas/              Zod request schemas
  prompts/              versioned run-graph prompts (execution/*.vN.md) + loader
  services/
    executionService.ts     execution state machine + approvals
    executionWorker.ts      plan/run/publish consumers, leases, recovery
    outboxService.ts        transactional outbox flusher
    ingestionService.ts     tracker-neutral ticket ingestion
    integrationPollingService.ts
    workspaceService.ts     Docker clone/verify/diff/publish, long-lived run sandbox
    agentGraph/             LangGraph run graph, agent loop, repo context, repo policy, diff review
    llm/                    provider registry, providers, tool calling, retries, output errors
    sandbox/                agent and reviewer tools (list/read/search/edit/run_check/run_command/skip_reproduction/finish/verdict) with policy + ToolCall recording
    toolchain/              repository environments: configuration, devcontainer, discovery, checks
    taskQueueService.ts, agentRunner.ts, promptBuilder.ts   task pipeline
    rabbitMQService.ts      connection, subscribe with retry/dead-letter
  integrations/         tracker adapters + registry, GitHub App
  utils/                code writer, safe paths, crypto, safe errors, LLM output parsing
prisma/                 schema and committed migrations
tests/                  unit tests (against dist/) and tests/e2e/
docs/                   plans, specs, testing, guides, history

# created at runtime (gitignored)
generated-code/         task pipeline output
workspaces/             execution scratch clones, deleted after each run step
artifacts/              approved diffs, one per execution
```

## Known limits

- **One tracker, one source host.** Trello is the only issue tracker and GitHub the only source control. Trackers are pluggable (`IssueTrackerAdapter`); source control is not yet (AUDIT A2).
- **Any language, still being proven.** The benchmark covers Node, Python (with and without PostgreSQL) and Go. The reference projects in other stacks have been run once each on an older model (`gpt-5-mini`), except the current Catch2 issue, which hasn't been run yet; on `gpt-5.6-luna`, only jq (C) has been measured so far, fixed 9 times in 10. Phase 4 of `docs/plans/AGENTIC_ROADMAP.md` is still in progress. The roadmap's "Known limitations" table lists every way the agent is still tied to one language, platform, service or kind of task, and the phase that removes each.
- **`single_shot` mode selects context by file name.** The agent sees up to 12 files whose paths match ticket words, each cut at 20 KB, and returns whole files, so vague tickets and very large files are weak spots. `tool_loop` mode reads and searches the repository itself.
- **Vague tickets can still get a wrong fix.** The agent sometimes adds new code beside the faulty function instead of fixing it. The reviewer catches this and the approver sees its objections, but the change still reaches approval.
- **One HTTP connector**, not a full Model Context Protocol transport. Skills and MCP resources are stored and assignable but not yet included in prompts.
- **Process-local** rate limiting and logs. Multi-instance deployments need a shared limiter (e.g. Redis), centralized logs, metrics and tracing.

## Project docs

- `CHANGELOG.md`: what changed in each version; every pull request adds a line under Unreleased.
- `AUDIT.md`: audit findings and fix-progress tracker.
- `docs/plans/`: roadmaps and project plans.
- `docs/specs/`: technical specifications (orchestration engine, LangGraph, provider infrastructure).
- `docs/testing/`: unit and end-to-end test plans.
- `docs/guides/`: Prisma and TypeScript guides.
- `docs/history/`: earlier phase plans and walkthroughs.

Planning docs describe intent and past phases; the code and this README describe current behaviour.

## License

Tickwright is licensed under the [Apache License 2.0](LICENSE).
