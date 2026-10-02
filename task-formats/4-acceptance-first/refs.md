# References

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
