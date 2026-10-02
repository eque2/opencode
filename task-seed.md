I would like you to update opencode to move the control of the execution of a task and its verification directly out of the usual user flow you might find in opencode or Claude CLI, and have it controlled by the harness.

## Some variables

eque2-code repo: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/eque2-code
the task: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/task-formats/blend/provider-ordering-admin.spec/T2-services.task
the task format: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/task-formats/blend/README.md (`format: task-spec/1`, JSON Schemas in `blend/schema/`, rules R1–R13)

Let's just focus on this task for the moment, not the higher-level spec

The task layout is aspirational. The target repository (where a task's `touches` live) is out of scope for now: T2's touches are vadz paths, and that does not matter yet. T2's dependencies outside the folder (T1.x, T3.x, …) are listed under `outside` in `SPEC.md`; each one is a precondition the harness checks in its state store (R12), not a reason to refuse the task.

And so we have some mechanism to induce the execution of a task and its verification, similar to a slash command, but idiomatic to the harness. `/task` maybe, providing a path to the task. It takes the task which drives the TypeScript opencode engine.

Research edge cases, what happens in the event of a verification failure, etc. Look at the eque2-code repo. Are the states for tasks in there adequate? (Answered below: no.)

## Decisions (2026-10-02)

1. Port eque2-code's effect-xstate (`src/packages/effect-xstate`, ~3.9k lines, a reimplementation of the XState v5 API on Effect 3.19, no xstate dependency, no eque2 imports) into opencode on Effect v4. `effect@4.0.0` has been stable on npm since 2026-10-01; opencode pins `4.0.0-rc.117`. Moving the catalog to 4.0.0 is a separate, earlier step.
2. v1 shows the task tree in the TUI: parent, children, each task's state, and each obligation's verdict.
3. `/task` is a new server-side command kind with an Effect handler. Today an opencode command is a prompt template only (`packages/opencode/src/command/index.ts`: name, description, agent, model, subtask, template), so it cannot run validation code before a model turn. Server-side means the TUI and the SDK both reach it.
4. Agents report to the harness through harness-only tools, built like `StructuredOutput` (`packages/opencode/src/session/prompt.ts:1265-1315`: a tool added for one turn, its arguments captured by a callback, the loop ended). The builder gets `task_ready`; the verifier gets `verdict`. The builder's agent never sees `verdict`.
5. `task_ready` is a request, not a fact. The harness then runs the proofs itself: the tests tagged with each obligation id, the gates, the unchanged-path checks. The agent's word moves nothing to trusted.
6. The harness owns the budgets and the loop exit (`runLoop` decides continue or stop). Nothing here ports the goal-gate Stop hook.
7. Task state is event-sourced in opencode's SQLite through `EventV2`; no new store. The harness owns the only write path, and the builder's permissions deny the database path. That is a deterrent, not a fence; say so, as eque2-code's policy does.

## Preamble

Pin down the format and various representations of the task. (Done: `task-formats/blend/`. Representations: the files → the parsed model in the blend README's "Parse target" → the runtime state, keyed by qualified id and unit hash.)

1. User (or you in testing) invokes `/task <path to task>`
2. Harness validates the task structurally in terms of format, dependencies etc. using imperative code: parse the front matter, validate it against the schemas, run R1–R13. Port the reference checker (`check_blend.py`, in the session scratchpad) to TypeScript, with Effect Schema as the one source and the JSON Schemas generated from it.
3. Using a similar mechanism to eque2-code [DS], the task is executed then validated, all by this new engine in opencode. For a parent such as T2: run the children in `after` order (in parallel where the order and the touch sets allow), then the parent's own obligations (T2.e1: one review of the combined diff).
4. Similar to [DS], the state is maintained, but by the harness. The executing agent notifies the harness that the task is ready (`task_ready`), the harness runs the proofs, and the verification agent reports its verdict per obligation (`verdict`)
5. Thus state management of tasks becomes a first-class citizen in opencode, much like a plan mode but rather more sophisticated, with nested dependencies, different states, etc. Use the ported effect-xstate (decision 1)
6. For tasks, we have a strict set of states ('not_done', 'verified', etc.), but this is a special instance and we should support any set of states: the lifecycle is a machine definition (data), and the task lifecycle is its first instance

## Are eque2-code's task states adequate?

No. eque2-code has two separate dimensions: each actor's machine state (`SubtaskMachine.ts`: `not_started → building → evaluating → completed | blocked | failed`) and an evidence trust level kept in the actor's context (`trust-graph.ts`: `untrusted, pending_review, verified, trusted, suspect`). The gaps:

1. A `complete` that fails verification never increments `attemptNumber`, so an agent can call it forever and no budget stops it.
2. No `cancelled` state. Only the test lifecycle has `ABORT`, and it goes to `failed`.
3. No "waiting on a dependency" state. `blocked` means "the same error three times", and it is final. `dependsOn` is only a query filter.
4. Stale-after-edit is not a state, only a trust demotion plus a cascade. `rejected` is not a state either: the verdict maps it to `suspect`.
5. `failed` is final for tasks; only `RESET` leaves it. The documented `pending_review → untrusted` edge is not implemented.

Proposed shape: two parallel regions instead of one machine with trust in its context.

- Work, per task: `waiting` (on a dependency or an `outside` precondition) → `ready` → `building` → `ready_for_proof` → `proving` → `done`, plus `cancelled`, `budget_exhausted` and `needs_human`.
- Evidence, per obligation: `unproved` → `proved` (the harness ran it and it passed) → `trusted` | `rejected` (the verdict), plus `stale` (its unit hash changed).
- A task is trusted when every obligation is trusted. A parent is trusted when every child is trusted and its own obligations are trusted.

## What happens when verification fails

| Event | What the harness does |
| --- | --- |
| A proof fails (a tagged test, a gate, an unchanged-path check) | Back to the builder with the failing ids. The attempt count goes up by one; at the budget, `budget_exhausted`. |
| The verifier rejects one obligation | Reopen that obligation only, with the reason. Its other obligations keep their verdicts. |
| A shared gate fails | Attribute it by the touch sets and the diff; if that does not single out one task, `needs_human`. |
| A scenario that needs several tasks fails | No task is at fault yet: `needs_human`. |
| The process crashes mid-build | Resume from the stored events; every step is idempotent. |
| The user edits `TASK.md` or `VERIFY.md` mid-run | The unit hash changes. That task or obligation goes `stale` and is built or proved again. |
| A `deployed` scenario in a local run | It waits; it is judged only in a run that has a deployed target. |

## Done when

1. `/task` on a small fixture task runs build → proofs → verdict → trusted with no human input.
2. `/task` on T2 parses it, passes R1–R13, and shows the task tree with T2.1–T2.6 waiting on their `outside` preconditions.
3. A forced rejection returns to the builder with the reasons, and only the rejected obligation is reopened.
4. An exhausted budget stops in a named state; a killed process resumes where it stopped.
5. The task tree in the TUI shows each task's state and each obligation's verdict as they change.

## Open questions

1. Name the second state set (point 6). The room's suggestion: build the task lifecycle as data first; a second instance is then cheap.
2. Who judges the parent's review obligation (T2.e1): a reviewer agent, a human, or either?
