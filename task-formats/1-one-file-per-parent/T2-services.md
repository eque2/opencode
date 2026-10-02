---
task: T2
title: "Implement services — source, routing semantics, dry run, attribution"
feature: provider-ordering-admin
phase: "2"
after: [T1]
---

# T2 — Implement services — source, routing semantics, dry run, attribution

Phase 2. The behaviour changes. Each subtask preserves a named property of the `provider-routing` workstream.

Review: one independent review of the combined T2 diff once T2.1–T2.6 are trusted.

---

## T2.1 — Add the `Database` routing-policy source variant

**After:** T1.2, T1.3 · **Supports:** S21, S25, S36, S41 · **Gates:** BUILD-2 · **Refs:** POA-D3

**Touches:**

- `libs/media/src/routing-policy-source.ts` — update: a `Database` case on `RoutingPolicySourceSpec`; `specUri` renders it as `db://routing-config`

### Goal

Let the live policy come from the table without teaching the policy service anything new.

### Approach

Extend **every** `$match` — the exhaustive matcher failing to compile is the intended safety net, not an obstacle. The source offers documents through the existing `load`, so the "a rejected replacement never removes the working policy" property is inherited rather than re-implemented.

### Preserve

- every `$match` stays exhaustive: a case missing from a matcher is a type error
- the poll interval, the retry count and the `unreachable` outcome semantics are untouched

### Must not

- modify `libs/media/src/routing-policy.ts` — the source offers documents through the existing `load`

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.1.c1]`.

1. `T2.1.c1` · *happy path* — the source reads rows, projects, and the policy service accepts the document.
2. `T2.1.c2` · *empty / null* — an empty table yields the empty policy and the service serves it — a fresh deployment with nothing configured boots and routes by default precedence.
3. `T2.1.c3` · *boundary* — the full catalogue projects and loads in one read.
4. `T2.1.c4` · *failure mode* — the database is unreachable → the source reports the existing `unreachable` poll outcome; the policy in force is untouched. (→ S21, S25)
5. `T2.1.c5` · *invalid input* — rows that project to a document naming an unregistered provider are refused by the existing load-time registry check, and the previous snapshot keeps serving.
6. `T2.1.c6` · *backwards compatibility* — `Gcs`, `File`, `Inline` and `None` behave exactly as before. (→ S41)

Proof hint: `libs/media/src/tests/verify-provider-ordering-admin-S25.spec.ts`

The verifier rejects:

- c4: asserting only that an error was reported. Compare the serving snapshot's identity before and after the failed read.
- c5: a refusal raised by new code in the source. The case is that the existing load-time registry check refuses it.
- c6: exercising one source. Each of `Gcs`, `File`, `Inline` and `None` needs its own assertion.

---

## T2.2 — Wire source selection, polling and load semantics

**After:** T2.1 · **Supports:** S18, S19, S21, S25, S39, S40, S41, S51, S57, S59 · **Refs:** POA-R2, POA-D7, EFF-32

**Touches:**

- `libs/media/src/routing-policy-source.ts` — update: extend `routingPolicySourceSpecConfig` so the source is selected by configuration
- `apps/api/src/main.ts` — update: wire the database-backed source
- `libs/media/src/routing-policy.ts` — update: the compare-and-swap refuses a document whose revision is older than the one in force (POA-R2)

### Goal

Make the database the selectable source, and prove the existing load properties still hold when reached through it.

### Approach

**Finding POA-R2:** the Apply path and the background poller are two independent writers of `RoutingPolicyService`. Without a revision comparison in the swap, a poll in flight across an Apply silently reverts the administrator's change for up to one poll interval — after they were told it succeeded. The swap must therefore refuse an older revision, not merely a matching hash.

### Preserve

- the existing environment variables keep selecting the source they select today
- `ROUTING_POLICY_DEFAULT_POLL_INTERVAL` and the bounded retry count — this task adds a source, it does not retune the poller
- the `RoutingPolicyLive` composition and `provideMerge` structure in `main.ts`
- a request sees one snapshot for its lifetime
- a rejected replacement never disturbs the serving snapshot

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.2.c1]`.

1. `T2.2.c1` · *happy path* — configuration selects the database source; the poller loads it on the existing interval.
2. `T2.2.c2` · *boundary* — re-reading an unchanged configuration reports `unchanged` and does not advance the generation counter. (→ S40)
3. `T2.2.c3` · *boundary* — a policy replacement landing mid-request does not change the decision that request already resolved; a request begun afterwards sees the replacement. (→ S39)
4. `T2.2.c4` · *failure mode* — a malformed projection is refused and the readiness surface reports `serving-stale`. (→ S18)
5. `T2.2.c5` · *failure mode* — the store is unreachable for several consecutive polls; the policy in force keeps serving throughout. (→ S21)
6. `T2.2.c6` · *concurrency* — a poll that began before an Apply and completes after it does not reinstate the pre-Apply configuration — the swap refuses a document whose revision is older than the one in force. (→ S57, POA-R2)
7. `T2.2.c7` · *invalid input* — a document refused by the catalogue-binding check leaves the previous policy serving and is reported. (→ S59)
8. `T2.2.c8` · *backwards compatibility* — the GCS-configured deployment path is untouched. (→ S41)

Proof hint: `libs/media/src/tests/verify-provider-ordering-admin-S39.spec.ts`

The verifier rejects:

- c2: asserting only that the outcome says `unchanged`. Assert that the generation counter did not advance.
- c3: swapping the policy before the request starts. The replacement must land after the request has resolved its decision and before it completes.
- c6: running the poll and the Apply one after the other. The poll must begin before the Apply and complete after it, or the test cannot fail.

---

## T2.3 — Update the router so a pair configured to serve nothing is not treated as unconfigured

**After:** T1.3, T1.6 · **Supports:** S3, S6, S7, S22, S44, S56 · **Refs:** POA-R1, POA-D4, POA-D7, EFF-10

**Touches:**

- `libs/media/src/provider-router.ts` — update: a pair configured with zero enabled providers fails with a new typed error instead of falling through to default precedence

### Goal

Make a deliberately-emptied pair fail loudly instead of silently reverting to the built-in default.

### Approach

This is the one genuine semantic change to `provider-router.ts`. Today an absent entry and a serve-nothing entry are indistinguishable; after this they must not be. Add a tagged failure alongside the existing `NoCandidateSatisfiesConstraints` rather than reusing it — the operator response differs completely ("your constraints excluded everything" versus "you switched everything off").

### Preserve

- candidate order is verbatim and never re-sorted
- a policy stays strictly additive over default precedence for every pair that is merely absent
- the failover gating

### Must not

- read the serve-nothing set from anywhere but the `PolicySnapshot`'s document (T1.6) — any other channel reintroduces POA-R1
- reuse `NoCandidateSatisfiesConstraints` for the serve-nothing case
- touch `routingPolicyHash`

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.3.c1]`.

1. `T2.3.c1` · *happy path* — a configured pair routes to its first enabled candidate in stored order, reported as `'policy'`.
2. `T2.3.c2` · *empty / null* — an absent pair routes by `orderedCandidatesFor`, reported as `'default-precedence'`. (→ S6, S44)
3. `T2.3.c3` · *boundary* — a pair configured with every provider disabled fails with a typed error naming the pair, distinguishable from the absent case. (→ S7)
4. `T2.3.c4` · *boundary* — a disabled provider is never a candidate, even when every enabled candidate has failed. (→ S3, S22)
5. `T2.3.c5` · *invalid input* — an override naming a disabled provider is refused by the existing `OverrideNotACandidate`, not silently honoured.
6. `T2.3.c6` · *regression* — candidate order is verbatim and never re-sorted; a policy for a pair remains strictly additive over default precedence for every pair that is merely absent.

Proof hint: `libs/media/src/tests/verify-provider-ordering-admin-S7.spec.ts`

The verifier rejects:

- c3: asserting only that an error occurred. Assert the error's tag and the pair it names; only that separates serve-nothing from absent.
- c4: a single failing candidate. Fail every enabled candidate, then assert the disabled provider was never called.

---

## T2.4 — Add the dry-run mode to the gateway

**After:** T1.4 · **Supports:** S8, S9, S10, S42, S53 · **Refs:** POA-D8

**Touches:**

- `libs/media/src/media-gateway.ts` — update: `GatewayRoutingContext` gains an optional dry-run field

### Goal

Let a caller ask "who would serve this?" and get a truthful answer without a provider call or a charge.

### Approach

Extend the input of `deriveIdempotencyKey` so the mode is part of the key: a dry run must neither collide with nor poison a live call's idempotency key.

### Preserve

- the estimate-drift / re-confirmation gate
- `deriveIdempotencyKey` — extended, not replaced
- `admitPinnedProviderId`

### Not in this task

- the short-circuit itself — this task supplies the mode and the money guarantee → T2.5

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.4.c1]`.

1. `T2.4.c1` · *happy path* — `'succeed'` resolves routing, records attribution, returns a synthetic success naming the provider. (→ S8)
2. `T2.4.c2` · *happy path* — `'fail'` returns the synthetic typed failure, attribution still recorded. (→ S9)
3. `T2.4.c3` · *empty / null* — no dry-run mode supplied → the call behaves exactly as before, including being charged. (→ S42)
4. `T2.4.c4` · *boundary* — a dry run on a pair with one candidate, and on a pair configured to serve nothing (the routing failure surfaces; the dry run does not mask it).
5. `T2.4.c5` · *failure mode* — no provider is contacted under either mode. (→ S10)
6. `T2.4.c6` · *money* — the wallet balance is unchanged and no charge row is created. (→ S53)
7. `T2.4.c7` · *security boundary* — the dry-run idempotency key cannot collide with a live call's, so a dry run can never satisfy or poison a real request's idempotency.

Proof hint: `libs/media/src/tests/verify-provider-ordering-admin-S8.spec.ts`

The verifier rejects:

- c5: asserting the returned value only. Use a provider stub that fails the test if it is entered.
- c6: checking the response. Read the wallet balance and the charge rows before and after.
- c7: checking that a key exists. Derive both keys for the same request and assert they differ.

---

## T2.5 — Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical

**After:** T1.4, T2.4 · **Supports:** S10, S55 · **Gates:** BUILD-4 · **Refs:** POA-A3.b, POA-D9

**Touches:**

- `libs/media/src/candidate-execution.ts` — update: the short-circuit sits after the candidate is chosen and before the provider adapter is entered, where the attempt record is still produced

### Goal

Make a dry run produce the *same* attribution record a live call produces — which is the entire reason a dry run can be used as proof.

### Approach

Placing the short-circuit here rather than higher in the gateway is what buys the shape-identity (POA-A3.b); the "no adapter entered" property is preserved and separately asserted.

### Preserve

- `AllProvidersExhausted` and `IncompatibleRequestSchema` semantics for live calls
- no provider adapter is entered on a dry run

### Must not

- let a synthetic failure trigger failover — otherwise `dryRun: 'fail'` would silently exercise the whole chain and report the wrong provider

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.5.c1]`.

1. `T2.5.c1` · *happy path* — the attempt record produced under dry run carries the same fields, in the same shape, as a live attempt record, differing only by the dry-run marker. (→ S55)
2. `T2.5.c2` · *boundary* — the short-circuit happens after the candidate is chosen and before the provider adapter is entered — assert with a provider stub that fails the test if entered at all. (→ S10)
3. `T2.5.c3` · *failure mode* — `'fail'` produces an attempt record marked failed, and the failover machinery is *not* triggered by it (a synthetic failure is not evidence that a provider is unavailable).
4. `T2.5.c4` · *regression* — `AllProvidersExhausted` and `IncompatibleRequestSchema` semantics are unchanged for live calls.

Proof hint: `libs/media/src/tests/verify-provider-ordering-admin-S55.spec.ts`

The verifier rejects:

- c1: comparing a few chosen fields. Compare the dry-run and live attempt records field by field.
- c3: asserting the failure only. Assert that the failover machinery made no further attempt.

---

## T2.6 — Write the routing-decision record and the generation attribution

**After:** T1.1, T2.4 · **Supports:** S27, S43, S58 · **Refs:** POA-R4, POA-D9

**Touches:**

- `libs/db/src/lib/extensions/versions.extensions.ts` — update: extend the existing `recordGeneration` input, and add the routing-decision write that every call makes, live or dry

### Goal

Make it impossible for a generation to exist without a record of why the provider that served it was chosen.

### Approach

Extend the existing `recordGeneration` input rather than adding a second write path for the generation half — the atomicity guarantee in the `0015` migration docblock depends on there being exactly one. The routing-decision record is a separate, additional write that every call makes, live or dry (POA-R4). Regenerate the DB types after T1.1 with `pnpm nx run db:codegen`.

### Preserve

- exactly one write path for the generation half
- existing `recordGeneration` callers compile unchanged

### Must not

- hand-edit the generated `libs/db/src/lib/{types.ts,schemas/,repositories/}`

### Verify

Each case is proved by a passing test whose title starts with its tag, for example `[T2.6.c1]`.

1. `T2.6.c1` · *happy path* — a recorded generation carries provider, routing source and policy hash, written in the same atomic step as the asset insert and wallet decrement. (→ S27)
2. `T2.6.c2` · *empty / null* — a caller that supplies none of the new fields still records successfully, and the absent fields are stored as absent, not invented. (→ S43)
3. `T2.6.c3` · *boundary* — a dry-run call writes a routing-decision record carrying the attribution and the dry-run marker, performs **no** wallet decrement, and writes **no** generation-history row — it has no asset to reference. (→ S58, POA-R4)
4. `T2.6.c4` · *boundary* — the routing-decision record is readable afterwards without reference to any artefact, which is what makes a dry run usable as proof of what a live request would do.
5. `T2.6.c5` · *failure mode* — if the attribution write fails, the whole record fails — there is no partial state in which the generation exists without it.
6. `T2.6.c6` · *regression* — existing callers compile unchanged (the new fields are optional).

Proof hint: `libs/db/src/lib/extensions/tests/verify-provider-ordering-admin-S27.spec.ts`

The verifier rejects:

- c3: asserting that a routing-decision row exists. Also assert there is no generation-history row and no wallet decrement.
- c5: a happy-path write. Make the attribution write fail and assert that no generation, asset or wallet change remains.

---

## Acceptance

The scenarios T2.1–T2.6 support. A scenario is proved by the tests tagged with its id.

```gherkin
@core
Scenario: S3 Switching a provider off removes it from consideration entirely
  Given a model whose ordering names two enabled providers
  When an administrator switches the first provider off and applies the change
  And a request for that model is then made
  Then the remaining enabled provider serves the request
  And the switched-off provider is not asked at all, even when the remaining provider fails
```

```gherkin
@core
Scenario: S6 A model with no stored ordering routes by the built-in default
  Given a model with no stored provider ordering
  When a request for that model is made
  Then it is served by the built-in default preference
  And the recorded decision states that the built-in default was the source of the choice
```

```gherkin
@core
Scenario: S7 A model whose providers are all switched off refuses to serve, distinguishably
  Given a model whose ordering exists but has every provider switched off
  When a request for that model is made
  Then the request fails with a reason that names the model and says it is configured to serve nothing
  And that failure is distinguishable from the case where the model has no stored ordering at all
```

```gherkin
@core
Scenario: S8 A dry run that is asked to succeed reports the provider it would have used
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode asking for a successful outcome
  Then the response is a success
  And it names the provider that a real request would have gone to
  And the result is unambiguously marked as not being a real generation
```

```gherkin
@core
Scenario: S9 A dry run that is asked to fail produces a failure without contacting anyone
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode asking for a failing outcome
  Then the request fails in the same way a real provider failure would present
  And the provider that would have been used is still recorded
```

```gherkin
@core
Scenario: S10 A dry run contacts no provider
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode
  Then no provider is contacted
  And no external call is made on the caller's behalf
```

```gherkin
@negative
Scenario: S18 A malformed submission is refused and the previous configuration keeps serving
  Given a stored provider ordering that is currently in force
  When an administrator submits a configuration that cannot be understood
  Then the submission is refused with a reason
  And the previously-stored ordering is still the one in force
```

```gherkin
@negative
Scenario: S19 A submission naming an unknown provider is refused, naming every unknown one
  Given a submission that names providers the system has nothing registered for
  When it is applied
  Then it is refused
  And the refusal names every unrecognised provider, not merely the first
```

```gherkin
@negative
Scenario: S21 When the configuration store cannot be reached the last good configuration keeps serving
  Given a configuration that has been loaded and is in force
  When the configuration store becomes unreachable
  Then requests continue to be routed by the configuration already in force
  And the operational surface reports that the newest read did not succeed
```

```gherkin
@negative
Scenario: S22 A failing first provider hands over to the next switched-on provider
  Given a model whose ordering names three providers, the second of which is switched off
  And the first provider fails in a way that permits another to be tried
  When a request for that model is made
  Then the third provider serves it
  And the switched-off second provider was never asked
```

```gherkin
@integrity
Scenario: S25 A refused configuration never disturbs the one that is serving
  Given a configuration in force
  When a replacement is offered and refused for any reason
  Then the configuration in force is byte-for-byte the one that was serving before
  And its identity is unchanged
```

```gherkin
@integrity
Scenario: S27 What served a request is recorded together with the request's outcome
  Given a request that results in a generation
  Then the provider that served it, the reason that provider was chosen, and the identity of the configuration in force are recorded as part of the same indivisible record as the generation itself
  And there is no state in which the generation exists without them
  And the same facts are also recorded as a routing decision in their own right, so a request that produces no artefact is still accounted for
```

```gherkin
@observability
Scenario: S36 An operator can see where the live configuration came from and whether the latest read worked
  Given a running service reading its configuration from the store
  When an operator inspects the operational surface
  Then it states which source the configuration in force came from
  And whether the most recent read of that source succeeded or was refused
```

```gherkin
@concurrency
Scenario: S39 A configuration change landing mid-request does not change that request
  Given a request that has begun and has already resolved which provider to use
  When the configuration is replaced while that request is still running
  Then the request completes against the provider it originally resolved
  And a request begun afterwards uses the replacement
```

```gherkin
@concurrency
Scenario: S40 Re-applying an identical configuration is not treated as a change
  Given a stored configuration
  When an administrator applies a configuration that is equivalent to the one already in force
  Then it is accepted
  And it is reported as unchanged rather than as a new configuration
```

```gherkin
@compat
Scenario: S41 The previously-supported configuration sources continue to work
  Given a deployment configured to read its routing configuration from its existing external source
  When the service starts and polls that source
  Then it loads and serves that configuration exactly as it did before this feature existed
```

```gherkin
@compat
Scenario: S42 A caller who says nothing about dry runs is unaffected
  Given a caller that makes a request without mentioning dry runs
  When the request is made
  Then it behaves exactly as it did before dry runs existed, including being charged
```

```gherkin
@compat
Scenario: S43 A caller that records a generation without the new detail still succeeds
  Given a caller that records a generation without stating the provider, the reason, or the configuration identity
  When the generation is recorded
  Then it is recorded successfully
  And the absent details are stored as absent rather than as invented values
```

```gherkin
@compat
Scenario: S44 Models nobody has configured behave exactly as before
  Given a deployment upgraded to this feature with no configuration stored at all
  When requests are made across the catalogue
  Then every model is served exactly as it was before the upgrade
```

```gherkin
@delivery
Scenario: S51 The deployed service reads its configuration from the store
  Given the service deployed to its hosting environment with the configuration store selected as its source
  When it starts
  Then it loads the stored configuration
  And routes requests by it
```

```gherkin
@money
Scenario: S53 A dry run costs nothing
  Given a caller with a known balance
  When they make a dry-run request, whether asked to succeed or to fail
  Then their balance is unchanged
  And no charge is created
```

```gherkin
@ASSUMPTION:A3.b
Scenario: S55 A dry run is recorded in the same shape as a real request
  Given a real request and a dry-run request for the same model
  Then the record of what served each is the same shape, carrying the same fields
  And the only difference is that one is marked as a dry run
  And that sameness is what makes a dry run usable as proof of what a real request would do
```

```gherkin
@integrity
Scenario: S56 A model configured to serve nothing is part of the configuration's identity
  Given two configurations that are identical except that one has a model configured to serve nothing
  Then they are not treated as the same configuration
  And the routing layer can tell, for any model, whether it is configured to serve nothing
  And that fact reaches the routing layer by the same route as the ordering itself, not by a separate channel
```

```gherkin
@concurrency
Scenario: S57 A slow read cannot undo a change that has already been applied
  Given a periodic read of the stored configuration that began before an administrator applied a change
  When that read completes after the change has taken effect
  Then it does not replace the newer configuration with the older one
  And the administrator's change is still the one in force
```

```gherkin
@integrity
Scenario: S58 A request that produces nothing still records which provider it would have used
  Given a dry-run request, which creates no artefact and no charge
  Then the provider it resolved to, the reason, and the identity of the configuration in force are recorded
  And that record is readable afterwards without reference to any artefact
  And it is marked as a dry run so it can never be mistaken for real work
```

```gherkin
@negative
Scenario: S59 A stored configuration naming a provider that cannot serve the model is refused
  Given a stored configuration naming a provider that is known to the system but cannot serve the model in question
  When that configuration is read
  Then it is refused
  And the refusal names every such provider, not merely the first
  And the configuration already in force keeps serving
```

## Gates

| Gate | Check | Command | Needs |
| --- | --- | --- | --- |
| BUILD-2 | Type check passes | `pnpm nx run-many -t typecheck -p ui,api,media,media-mcp,contracts,db` | Node 22 |
| BUILD-4 | Tests pass | `pnpm nx run-many -t test-ci -p ui,api,media,media-mcp,contracts,db` | Node 22; `test-ci`, not `test`, because `nx test` hangs locally |

## Verification policy

- **red-first** — A failing test for each case lands before the change that makes it pass.
- **proof-binding** — A test proves an id when its title starts with `[<id>]`, for example `[T2.1.c4]` or `[S25]`. File paths are hints; the tag is the binding.
- **structural** — Every case id has at least one tagged test; each tagged test ran and passed at the task's final commit; the task's commits change only the files it declares, plus tests.
- **review** — One independent review of each parent task's combined diff once all its subtasks are trusted. Fixes land in their own commits.
- **trust** — An independent verifier, never the builder, judges that every case and every scenario step is proved by an assertion that would fail if the behaviour broke. A rejection returns the task with reasons.
- **acceptance** — A scenario is judged once every task that supports it is trusted, by running the tests tagged with its id.
- **evidence** — Runner exit code, pass and fail counts, run id and commit. Scenarios: the signed reporter evidence of that run.
- **budgets** — 10 build attempts per task; 3 retries per scenario or gate.

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
