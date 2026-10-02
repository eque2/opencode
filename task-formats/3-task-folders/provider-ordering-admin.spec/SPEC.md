---
spec: provider-ordering-admin
title: "Admin-configurable provider ordering per model"
---

# Admin-configurable provider ordering per model

The folder is the spec. Child `*.task` folders are tasks; `acceptance/` holds the scenarios. Only
`T2` is included in this example.

## Verification policy

Inherited by every task in this spec. A task's `VERIFY.md` may override one line, never remove one.

- **red-first** — A failing test for each case lands before the change that makes it pass.
- **proof-binding** — A test proves an id when its title starts with `[<id>]`, for example `[T2.1.c4]` or `[S25]`. File paths are hints; the tag is the binding.
- **structural** — Every case id has at least one tagged test; each tagged test ran and passed at the task's final commit; the task's commits change only the files it declares, plus tests.
- **review** — One independent review of each parent task's combined diff once all its subtasks are trusted. Fixes land in their own commits.
- **trust** — An independent verifier, never the builder, judges that every case and every scenario step is proved by an assertion that would fail if the behaviour broke. A rejection returns the task with reasons.
- **acceptance** — A scenario is judged once every task that supports it is trusted, by running the tests tagged with its id.
- **evidence** — Runner exit code, pass and fail counts, run id and commit. Scenarios: the signed reporter evidence of that run.
- **budgets** — 10 build attempts per task; 3 retries per scenario or gate.

## Gates

| Gate | Check | Command | Needs |
| --- | --- | --- | --- |
| BUILD-2 | Type check passes | `pnpm nx run-many -t typecheck -p ui,api,media,media-mcp,contracts,db` | Node 22 |
| BUILD-4 | Tests pass | `pnpm nx run-many -t test-ci -p ui,api,media,media-mcp,contracts,db` | Node 22; `test-ci`, not `test`, because `nx test` hangs locally |

## References

- **POA-D3** — A `Database` variant of `RoutingPolicySourceSpec`, added alongside `None`/`Inline`/`File`/`Gcs`, not replacing them.
- **POA-D4** — An unconfigured `(model, feature)` has no projected entry and routes by the existing default precedence, reported as `'default-precedence'`.
- **POA-D7** — Apply is a whole-document, single-transaction, optimistically-concurrent write keyed on the stored configuration's revision. Zero enabled providers is a legal "do not serve" state that fails the pair with a typed error.
- **POA-D8** — Generic `dryRun: 'succeed' | 'fail'`, short-circuiting before any provider HTTP call and any wallet debit.
- **POA-D9** — Attribution (provider + `RoutingSource` + `policyHash` + dry-run flag) is persisted, logged, metered and returned, including over MCP.
- **POA-R1** — The serve-nothing set travels inside the policy document: the router sees only the `PolicySnapshot`'s document, and `routingPolicyHash` covers only the document.
- **POA-R2** — The Apply path and the background poller are two independent writers of `RoutingPolicyService`; the swap must refuse a document whose revision is older than the one in force.
- **POA-R4** — `generation_history.asset_id` references `assets`, so a dry run, which has no asset, records its attribution in a separate `routing_decisions` table.
- **POA-A3.b** — The dry-run short-circuit sits in `candidate-execution.ts`, so the attempt record is produced exactly as a live call produces it.
- **EFF-10** — Domain failures are typed errors in the error channel (`Data.TaggedError`), never thrown, never `Effect.die` for an expected refusal.
- **EFF-32** — No read-then-write across a `yield*` where an invariant spans it; the existing `Ref.modify` compare-and-swap is the reference.
