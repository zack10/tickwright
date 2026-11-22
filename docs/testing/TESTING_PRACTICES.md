# Testing practices

Written 2026-11-16. How this project tests from now on, so that work is correct when it is merged and stays correct afterwards. `CLAUDE.md` section 7 holds the evidence rules for agent changes and paid runs; this file does not repeat them, it says where they fit.

Each practice is marked **in place** (the project already does it, keep doing it) or **to build** (agreed, not there yet, with the roadmap row that tracks it). A practice marked "to build" is not a rule until it exists: do not claim it in a pull request.

## 1. Principles

1. **A test answers one question, chosen before it runs.** The pass bar, the stop rule and the cost are fixed first. A result is reported against that bar, also when it is missed.
2. **The cheapest test that can catch a fault is the one that must catch it.** A fault found by a paid run that a unit test could have found is a missing unit test: add it in the same change.
3. **Every fault becomes a test.** A bug fix starts with a test that fails for the reason in the report, and ends with that test passing.
4. **A test that sometimes fails is a fault, not noise.** It is fixed or removed within the week, never rerun until green.
5. **Only what was exercised is claimed.** A passing unit test says nothing about Docker, git or a live service. Say what ran and what did not.
6. **Measure the product, not the benchmark.** A benchmark at its ceiling and public tickets tell less every week. Real tickets on our own repositories are the measure that counts.

## 2. The levels, and what each one is for

| Level | What it proves | Cost | Runs | State |
| --- | --- | --- | --- | --- |
| Lint and build | The code compiles and follows the lint rules | Free, seconds | Every pull request (`npm run verify`) | In place |
| Unit tests (`tests/*.test.js`) | One rule of one module, on compiled output | Free, a minute | Every pull request | In place |
| Docker tests (inside the unit suite) | The sandbox, the workspace and the benchmark scenarios behave in real containers | Free, minutes; skipped without Docker | Every pull request (the CI runner has Docker) | In place |
| Pipeline test with a scripted model (`npm run test:pipeline`) | A ticket reaches `COMPLETED` through the real state machine, outbox, approvals and Docker sandbox, with no model, tracker or source host | Free, about a minute | Every pull request (CI job `pipeline`) | Happy path in place; races and recovery still to add (limitation 55, `AUDIT.md` X4) |
| Live suites (`npm run test:e2e`) | The app works against a real tracker, a real source host and a real model | Cents; needs `.env.e2e` and a running server | Before a release, and after a change to an adapter | In place, run by hand |
| Coding benchmark x3 (`npm run eval:coding -- --runs 3 --parallel 4`) | An agent change did not make the agent worse | About a dollar, 25 minutes | Before every agent or prompt change is committed | In place |
| Reference projects (`npm run eval:reference`) | The agent copes with real projects in several stacks | Cents to a dollar per run; 10 runs per ticket | At a phase gate, and to diagnose one project | In place |
| Reviewer eval (`npm run eval:reviewer`) | A reviewer change judges stored diffs as well as before | A dollar or two | Before a reviewer prompt change | In place |
| Real tickets | A person merges what the agent wrote | Cents | Continuously, from now | **To start** (gate rule 5, limitation 50) |

The second-cheapest level that is missing today is the most valuable one to add: without the scripted pipeline test, every change to the pipeline is trusted only after a paid run.

## 3. What to run for which change

| The change touches | Before the pull request | Before it is merged |
| --- | --- | --- |
| Docs only | Nothing | CI green |
| A route, controller, schema, utility | `npm run verify`, with a new or changed unit test | CI green |
| The state machine, outbox, worker, queue, leases | `npm run verify` and `npm run test:pipeline` (CI runs both) | CI green |
| `workspaceService.ts`, the toolchain, discovery, the sweep | `npm run verify` **with Docker running** (confirm the Docker tests ran and did not skip) | CI green; one reference project that uses the changed path, 10 runs, if the change alters what a run does |
| A tracker or source-host adapter | `npm run verify`, then `npm run test:e2e` against the real service | CI green |
| A prompt, the plan step, the run graph, the tools, the policy | `npm run verify`, then the x3 benchmark on an image that contains the change | No drop in pass rate and no new wrong fix against the last recorded x3 |
| The reviewer | As above, and `npm run eval:reviewer` first | As above |
| A benchmark scenario or a grader | `tests/codingScenarios.test.js` with Docker | CI green |
| A database migration | `npm run verify`, the migration applied to a copy of real data | CI green; the migration's manual step, if any, in the changelog |
| A dependency | `npm run verify`, `npm audit --omit=dev` | CI green |

"With Docker running" matters: the Docker tests skip themselves without it, and a skipped test passes. Read the test output for the skip count before trusting a local run.

## 4. Rules for non-regression

1. **A bug fix carries the test that would have caught it.** The test is written first and seen to fail. A fix with no such test is not finished.
2. **A test is never weakened to make a change pass.** Deleting an assertion, loosening a bound, skipping or quarantining a test needs its own line in the pull request saying why the old expectation was wrong.
3. **Baselines are recorded, not remembered.** The last x3 result is the newest `docs/testing/coding-eval-*.md` with "Runs per scenario | 3". A comparison names the two reports.
4. **Like is compared with like.** An x3 only with an x3; a project only with the same ticket, model, step limit and code path; never a result on one model with a result on another (limitation 54).
5. **A gate reruns everything older.** A phase cannot pass by breaking an earlier phase's projects or the benchmark.
6. **A safety rule has a test at both places it is enforced:** in the tool that refuses the action, and on the final diff. A rule tested only in the tool can be passed around with a shell command.
7. **A prompt change is a new file.** Results stay tied to the text that produced them; `tests/prompts.test.js` renders every live prompt.
8. **A fault found outside the tests is recorded where it will be seen again:** a limitation row in the roadmap, or an item in `AUDIT.md`, with the run that showed it.

## 5. Writing a test

- **The name is a full sentence that states the rule**, so a failure reads as the rule that broke.
- **One reason to fail.** A test that checks three things hides which one broke.
- **Deterministic.** No dependence on the current time, the time zone, the host's language, the order of tests, the network, or what an earlier test left behind. Each of these has already cost a run here: a grader test that fails at .999 of a second, a test that fails under a French locale, a test that passed only with network.
- **Test the rule at its edge.** The limit itself, one below and one above; the empty input; the input with the dangerous character (`..`, a NUL, a CRLF, a symlink).
- **A test of a refusal checks the reason**, not only that something was refused.
- **No test asserts a model's wording.** Assert the structure of what the code does with a reply; model behaviour is measured by evals, with enough runs.
- **New test files are added to the `test` script in `package.json`.** A file that is not listed never runs.
- **Tests run against `dist/`.** Build first, always.

## 6. Evals: keeping the measurements honest

The rules for when an eval may be started, and how its result is reported, are in `CLAUDE.md` section 7. These are the practices around them.

1. **Hidden tests stay hidden.** They are never pushed to the sandbox repository and never shown to the agent.
2. **Every scenario is proven valid before it is used:** its hidden tests fail on the unmodified code and pass on the reference fix, in the grader image (`tests/codingScenarios.test.js`; for reference tickets, the checks recorded in limitation 40).
3. **A grader fault is fixed in the grader, and the affected runs are graded again.** A run is never counted by hand as "really correct".
4. **Held-out tickets are run only at a gate**, and nobody reads their runs while a phase is built. Once one fails and is diagnosed, it joins the ordinary set and another replaces it.
5. **Public tickets overstate.** Every reference project is a public issue with a public fix, which a model may have seen in training, and a stronger model more so. Do not read a reference result as what a team will see on private code.
6. **Every failed run gets one cause** from the fixed list: environment, the agent's own test, step limit, wrong change, reviewer, infrastructure, ticket. Priorities come from the counts.
7. **Infrastructure failures are counted and investigated, not excluded and forgotten.** A rate excludes them; the report still lists them, and three with one cause is a bug to fix before the next batch.
8. **Report cost per correct change beside the pass rate.** A change that buys quality at four times the price must be seen as one.
9. **The benchmark detects regressions; real tickets show gains.** Every scenario has passed in every x3 since 2026-11-11, and eight harder synthetic scenarios also passed 40 of 40 (2026-11-22, limitation 40), so a claimed improvement is shown on real tickets: reference tickets at 10 runs each, or our own tickets through the tracker. A scenario is still worth adding when it reproduces one of our own rejected or edited pull requests (limitation 50).
10. **Batch agent changes.** Several changes, one x3. An eval after every edit tunes the agent to the benchmark and spends the budget on noise.
11. **Two attempts per cause.** A project that misses its bar is diagnosed and fixed once, and rerun once. A second miss is recorded as a limitation; it is not patched a third time.

## 7. Real use

**To start now.** This is the only measurement no model has seen and no benchmark can replace.

- Run the agent on real tickets from our own backlog, starting with small ones.
- Record each as **merged as it was**, **merged after edits** or **rejected**, with the reason and, when edited, what the person changed.
- Track three numbers: the share merged as written, the share of plans that needed a revision, and the share of changes a person rejected after the reviewer approved.
- Every rejected or edited change is a candidate benchmark scenario: the ticket, the base commit, and the merged tests as hidden tests.

## 8. The app itself

- **Dependencies:** `npm audit --omit=dev` at high severity fails the build, with a recorded exception when a finding cannot be reached. **To build** (limitation 57).
- **Migrations** are tried on a copy of real data before they are merged, and never applied with `prisma db push`.
- **A release** is cut only after `npm run verify`, `npm run test:e2e` against the production stack, and the last x3 being from the released code or later.
- **The production stack is not rebuilt while an execution runs.** Check first; a stopped eval leaves its last run going.

## 9. Before saying a change is tested

1. `npm run verify` passed; the pass count and the skip count are in the pull request.
2. New logic has a test, and a bug fix has the test that failed before it.
3. The Docker tests ran, if the change touches Docker, git or the workspace.
4. The row of section 3 for this change was followed, or the pull request says what was not run and why.
5. For an agent change: the two x3 reports that were compared are named.
6. What the tests do **not** show is written down.

## 10. What we do not do

- Rerun a failed test or eval "to see if it happens again" before reading the failed case.
- Conclude from 1 to 3 runs of a scenario.
- Skip, disable or loosen a test to get CI green.
- Compare results across models, step limits or prompt versions as if they were one series.
- Start a paid run without a stated model, cost, bar, stop rule and cap, and an explicit yes.
- Count a skipped Docker test as a pass.
- Tune a prompt on the tickets that will grade it.
