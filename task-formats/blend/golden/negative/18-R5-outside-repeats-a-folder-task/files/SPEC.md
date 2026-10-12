---
format: task-spec/1
policy:
  redFirst: true
  proofBinding: title-tag
  structural: touches-plus-tests
  review: parent-diff
  trust: independent-verifier
  acceptance: after-all-needs-trusted
  evidence: [exit-code, counts, run-id, commit, signed-reporter]
  budgets: {taskAttempts: 10, retries: 3}
  judges:
    test: [runner, verifier]
    gate: [runner]
    unchanged: [engine]
    review: [reviewer]
gates:
  BUILD-2:
    title: "Type check passes"
    command: "pnpm nx run-many -t typecheck -p ui,api,media,media-mcp,contracts,db"
    requires: "Node 22"
  BUILD-4:
    title: "Tests pass"
    command: "pnpm nx run-many -t test-ci -p ui,api,media,media-mcp,contracts,db"
    requires: "Node 22; `test-ci`, not `test`, because `nx test` hangs locally"
refs:
  POA-D3: "A `Database` variant of `RoutingPolicySourceSpec`, added alongside `None`/`Inline`/`File`/`Gcs`, not replacing them."
  POA-D4: "An unconfigured `(model, feature)` has no projected entry and routes by the existing default precedence, reported as `'default-precedence'`."
  POA-D7: "Apply is a whole-document, single-transaction, optimistically-concurrent write keyed on the stored configuration's revision. Zero enabled providers is a legal \"do not serve\" state that fails the pair with a typed error."
  POA-D8: "Generic `dryRun: 'succeed' | 'fail'`, short-circuiting before any provider HTTP call and any wallet debit."
  POA-D9: "Attribution (provider + `RoutingSource` + `policyHash` + dry-run flag) is persisted, logged, metered and returned, including over MCP."
  POA-R1: "The serve-nothing set travels inside the policy document: the router sees only the `PolicySnapshot`'s document, and `routingPolicyHash` covers only the document."
  POA-R2: "The Apply path and the background poller are two independent writers of `RoutingPolicyService`; the swap must refuse a document whose revision is older than the one in force."
  POA-R4: "`generation_history.asset_id` references `assets`, so a dry run, which has no asset, records its attribution in a separate `routing_decisions` table."
  POA-A3.b: "The dry-run short-circuit sits in `candidate-execution.ts`, so the attempt record is produced exactly as a live call produces it."
  EFF-10: "Domain failures are typed errors in the error channel (`Data.TaggedError`), never thrown, never `Effect.die` for an expected refusal."
  EFF-32: "No read-then-write across a `yield*` where an invariant spans it; the existing `Ref.modify` compare-and-swap is the reference."
outside:
  T2.1: "clash"
  T1.1: "Create the routing-configuration and attribution migration"
  T1.2: "Implement `RoutingConfigExt` — transactional read and replace"
  T1.3: "Implement the rows → policy-document projection"
  T1.4: "Create the generic dry-run vocabulary"
  T1.5: "Add the admin configuration wire contract"
  T1.6: "Add the serve-nothing set to the policy document and its identity"
  T3.2: "Implement the apply-configuration endpoint"
  T3.5: "Expose dry-run over MCP and return the attribution"
  T3.8: "Update readiness with source identity, last read and coverage"
  T4.1: "Add the typed configuration client and error copy"
  T4.5: "Build the reorderable, toggleable provider list"
  T5.3: "Validate that the deployed service reads the store"
---

# Admin-configurable provider ordering per model

This folder is one spec. The front matter above is the whole machine contract for the spec: the verification
policy every task inherits, the gates with their commands, and the references tasks cite.

`outside` lists tasks of this spec that the folder does not contain. Each one is a precondition: a task or a
scenario that depends on one waits until the state store records it as trusted. This example is a slice (parent
T2) of a 28-task spec, so it names 12 of them.
