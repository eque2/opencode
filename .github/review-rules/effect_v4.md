---
Name: Effect v4 (TypeScript)
Source: https://github.com/Effect-TS/effect-smol (LLMS.md, MIGRATION.md, migration/*.md)
Last Updated: 2026-09-30
---

# Effect v4 Review Rules

> Target: `effect` 4.0.0-rc.117. The Effect ESLint bundle (v4, 54 rules), oxlint, and the
> `@effect/language-service` diagnostics already block the mechanical violations: Promise
> control flow, throw, try/catch, `new Error`, null, `JSON.parse`, native timers and
> collections, `process.env`, `console`, `Date`, `fs`, legacy `Context.Tag`/`Effect.Service`,
> floating Effects, and outdated APIs. The type checker rejects removed v3 names. Do not
> restate those findings. Review for the semantic defects below, which no tool detects.

## PR Review Comment Format

When you report a violation from this guide, use this format:

```
**[{Rule-ID}: {Rule Name}]** {SEVERITY}
**Issue:** Brief description of what's wrong
**Why this matters:** Explanation from the style guide
**Suggested fix:**
  {corrected code}
**Reference:** {link to official guide section}
```

Severity: CRITICAL blocks the merge. IMPORTANT needs a fix or a written reason. RECOMMENDED is advisory.

---

## Naming Conventions

### EFX-01: Effectful function without a named `Effect.fn`

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#using-effectfn
**Do:** Wrap each function that returns an Effect in `Effect.fn("Owner.method")`, with a name that matches.
**Avoid:** A plain arrow function that returns `Effect.gen`, or an `Effect.fn` name that does not match the function.
**Why?** The name becomes the tracing span and the stack frame. Without it, a failure in production shows an anonymous generator, and traces cannot attribute latency to the operation. A copied name that does not match is worse, because it points investigators at the wrong code.

**(AVOID) Example:**
```ts
export const loadProfile = (id: ProfileId) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles
    return yield* profiles.find(id)
  })
```

**Correct Example:**
```ts
export const loadProfile = Effect.fn("Profiles.load")(function* (id: ProfileId) {
  const profiles = yield* Profiles
  return yield* profiles.find(id)
})
```

### EFX-02: Service identifier that can collide

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#contextservice
**Do:** Use an identifier that names the package and the module path.
**Avoid:** A short generic identifier such as `"Config"`, `"Client"`, or `"Store"`.
**Why?** The identifier is the runtime key of the service map. Two packages that both register `"Config"` replace each other silently, and the failure appears far from the cause.

**(AVOID) Example:**
```ts
export class Store extends Context.Service<Store, StoreShape>()("Store") {}
```

**Correct Example:**
```ts
export class Store extends Context.Service<Store, StoreShape>()("app/session/Store") {}
```

## Effects and Functions

### EFX-06: `.pipe` applied to an `Effect.fn` result

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#using-effectfn
**Do:** Pass spans, annotations, and recovery as extra arguments to `Effect.fn`.
**Avoid:** `Effect.fn(...)(function* ...).pipe(...)`.
**Why?** The extra arguments of `Effect.fn` apply to each call inside the named span. A trailing `.pipe` operates on the function value, which does not compile as intended or silently drops the behaviour from the span.

**(AVOID) Example:**
```ts
const syncProfile = Effect.fn("Profiles.sync")(function* (id: ProfileId) {
  const client = yield* ProfileClient
  return yield* client.push(id)
}).pipe(Effect.annotateLogs({ operation: "sync" }))
```

**Correct Example:**
```ts
const syncProfile = Effect.fn("Profiles.sync")(
  function* (id: ProfileId) {
    const client = yield* ProfileClient
    return yield* client.push(id)
  },
  Effect.annotateLogs({ operation: "sync" }),
)
```

### EFX-07: Pure logic wrapped in an Effect

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#writing-effect-code
**Do:** Keep parsing, option building, and pure computation as plain synchronous functions.
**Avoid:** `Effect.succeed`/`Effect.sync`/`Effect.gen` around code that has no effect.
**Why?** A needless Effect hides a pure contract, adds allocation on hot paths, and forces every caller into a generator. Pure functions are also simpler to test.

**(AVOID) Example:**
```ts
const toQuery = (filter: ProfileFilter) =>
  Effect.sync(() => ({ status: filter.status, limit: filter.limit ?? 50 }))
```

**Correct Example:**
```ts
const toQuery = (filter: ProfileFilter) => ({ status: filter.status, limit: filter.limit ?? 50 })
```

## Services and Layers

### EFX-11: Service read with `.use()` instead of `yield*`

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/services.md
**Do:** Bind the service with `yield*` to a named variable, then call its methods.
**Avoid:** `Service.use((s) => ...)` inside feature code, and repeated `.use` calls in one workflow.
**Why?** `use` hides the dependency from the call site, which makes it easy to leak service requirements into a return type. The official v4 guidance prefers `yield*` in most cases. ESLint cannot flag this because it needs the receiver type.

**(AVOID) Example:**
```ts
const notifyTwice = Effect.andThen(
  Notifications.use((n) => n.send("start")),
  Notifications.use((n) => n.send("end")),
)
```

**Correct Example:**
```ts
const notifyTwice = Effect.fn("Alerts.notifyTwice")(function* () {
  const notifications = yield* Notifications
  yield* notifications.send("start")
  yield* notifications.send("end")
})
```

### EFX-12: Layer built without its dependencies wired

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/services.md#effectservice--contextservice-with-make
**Do:** Build the layer with `Layer.effect` and wire each dependency with `Layer.provide`.
**Avoid:** Expecting `make` to generate `.Default`, or relying on a caller to provide a dependency that the layer owns.
**Why?** v4 `Context.Service` with `make` generates no layer and has no `dependencies` option. A layer that leaves an owned dependency open pushes the wiring to every consumer and hides the graph.

**(AVOID) Example:**
```ts
class Logger extends Context.Service<Logger>()("app/log/Logger", { make: makeLogger }) {}
const main = program.pipe(Effect.provide(Logger.make))
```

**Correct Example:**
```ts
class Logger extends Context.Service<Logger>()("app/log/Logger", { make: makeLogger }) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(LogConfig.layer))
}
const main = program.pipe(Effect.provide(Logger.layer))
```

### EFX-13: Layers provided piecemeal through the program

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/layer-memoization.md#prefer-layer-composition-over-multipl-provides
**Do:** Compose the layer graph and provide it once at the entry point.
**Avoid:** Several `Effect.provide` calls scattered across feature code, or a provide inside a function that callers run many times.
**Why?** v4 memoizes across provides as a safety net, not as a design tool. Scattered provides hide which services a program needs, and they make missing or duplicate services hard to see in review.

**(AVOID) Example:**
```ts
const handle = (request: Request) =>
  process(request).pipe(Effect.provide(Profiles.layer), Effect.provide(Database.layer))
```

**Correct Example:**
```ts
const AppLayer = Profiles.layer.pipe(Layer.provide(Database.layer))
const main = server.pipe(Effect.provide(AppLayer))
```

### EFX-14: Stateful layer shared by v4 memoization

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/layer-memoization.md
**Do:** Use `Layer.fresh(layer)` or `Effect.provide(layer, { local: true })` when each use needs its own instance, and state why at the site.
**Avoid:** A chained or repeated provide of a stateful layer (a pool, a registry, a counter) that the author expects to rebuild.
**Why?** v3 rebuilt a layer for each `Effect.provide` call. v4 shares one `MemoMap` across calls, so the second provide silently reuses the first instance. The defect is silent: the first sign is usually a test that passes for the wrong reason. The language service `multipleEffectProvide` diagnostic flags some cases, but only a reviewer can judge whether the layer holds state.

**(AVOID) Example:**
```ts
// Each tenant gets a fresh pool.
const runForTenant = (tenant: TenantId) =>
  handleTenant(tenant).pipe(Effect.provide(ConnectionPool.layer))
```

**Correct Example:**
```ts
// Each tenant must get its own pool; v4 would otherwise share one.
const runForTenant = (tenant: TenantId) =>
  handleTenant(tenant).pipe(Effect.provide(ConnectionPool.layer, { local: true }))
```

### EFX-15: Cyclic or overlapping layer graph

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#writing-effect-services
**Do:** Keep the layer graph acyclic, and keep each service small with methods named for its domain.
**Avoid:** A service that depends, through other layers, on itself; a large service with unrelated responsibilities; two services with the same method shape.
**Why?** A cycle fails at construction with a message far from the cause. Large services are hard to replace in tests. Services with an identical structure can satisfy each other's type, so a reviewer must confirm that the correct one is provided.

**(AVOID) Example:**
```ts
class App extends Context.Service<App, {
  readonly getUser: (id: UserId) => Effect.Effect<User>
  readonly sendEmail: (mail: Mail) => Effect.Effect<void>
  readonly track: (event: AnalyticsEvent) => Effect.Effect<void>
}>()("app/App") {}
```

**Correct Example:**
```ts
class Users extends Context.Service<Users, { readonly get: (id: UserId) => Effect.Effect<User> }>()("app/user/Users") {}
class Mailer extends Context.Service<Mailer, { readonly send: (mail: Mail) => Effect.Effect<void> }>()("app/mail/Mailer") {}
```

## Errors

### EFX-16: Domain error without a schema

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md#error-handling
**Do:** Define errors that cross HTTP, RPC, or persistence with `Schema.TaggedErrorClass`, with the fields a handler needs.
**Avoid:** An error with no context fields, or an error that carries only a message string.
**Why?** A schema error serialises across boundaries and gives handlers typed fields. An error with only a message forces handlers to parse text, and it drops the identifiers that support needs.

**(AVOID) Example:**
```ts
export class Failed extends Schema.TaggedErrorClass<Failed>()("Failed", { message: Schema.String }) {}
```

**Correct Example:**
```ts
export class UpstreamFailed extends Schema.TaggedErrorClass<UpstreamFailed>()("UpstreamFailed", {
  service: Schema.String,
  cause: Schema.Defect(),
}) {}
```

### EFX-17: Error channel wider or narrower than reality

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/error-handling.md
**Do:** Declare the exact union of tagged errors, and confirm that each branch of the body matches it.
**Avoid:** `unknown` or a broad base error in the channel; `Effect.orDie` that erases an error a caller should see.
**Why?** Callers can only handle what the type shows. A widened channel hides the cases that need handling. An `orDie` that converts a recoverable failure into a defect removes the caller's choice and turns a retryable failure into a crash.

**(AVOID) Example:**
```ts
const load = (id: ProfileId) => fetchProfile(id).pipe(Effect.orDie)
```

**Correct Example:**
```ts
const load = Effect.fn("Profiles.load")(function* (id: ProfileId): Effect.fn.Return<Profile, ProfileNotFound | UpstreamFailed> {
  return yield* fetchProfile(id)
})
```

### EFX-18: `die` and `fail` used for the wrong kind of failure

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/cause.md
**Do:** Fail with a tagged error when a caller can recover; die only for a broken invariant.
**Avoid:** `Effect.die` for bad input, missing records, or upstream outages; `Effect.fail` for states that correct code cannot reach.
**Why?** Ask two questions. Can the caller recover? Then fail. Is this a bug? Then die. A misclassified defect crashes on a recoverable error; a misclassified failure lets a bug look like handled business logic.

**(AVOID) Example:**
```ts
const decodeRow = (row: unknown) =>
  Schema.decodeUnknownEffect(ProfileRow)(row).pipe(Effect.catch(() => Effect.die("bad row")))
```

**Correct Example:**
```ts
const decodeRow = (row: unknown) =>
  Schema.decodeUnknownEffect(ProfileRow)(row).pipe(Effect.mapError((cause) => new CorruptRow({ cause })))
```

### EFX-19: Foreign failure passed through untyped

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/01_effect/01_basics/10_creating-effects.ts
**Do:** Map the rejection of `Effect.tryPromise`/`Effect.try` to a tagged error in the `catch` option, and keep the cause.
**Avoid:** The single-argument form, which yields an untyped `UnknownError`; a `catch` that drops the cause.
**Why?** Code after the boundary must see one typed failure. The cause keeps the stack and the upstream detail for diagnosis. Pass the `signal` so that interruption cancels the request.

**(AVOID) Example:**
```ts
const fetchRemote = (id: ProfileId) => Effect.tryPromise(() => sdk.profiles.get(id))
```

**Correct Example:**
```ts
const fetchRemote = (id: ProfileId) =>
  Effect.tryPromise({
    try: (signal) => sdk.profiles.get(id, { signal }),
    catch: (cause) => new UpstreamFailed({ service: "profiles", cause }),
  })
```

### EFX-20: Blanket recovery that swallows unrelated failures

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/error-handling.md
**Do:** Recover with `Effect.catchTag`, `catchTags`, or `catchReason` for the failures you intend to handle.
**Avoid:** `Effect.catch` or `Effect.ignore` that recovers from every failure when only one is expected.
**Why?** A blanket handler converts every future failure, including new ones, into the fallback value. The type then claims the effect cannot fail, and outages look like empty results.

**(AVOID) Example:**
```ts
const profile = load(id).pipe(Effect.catch(() => Effect.succeed(guestProfile)))
```

**Correct Example:**
```ts
const profile = load(id).pipe(Effect.catchTag("ProfileNotFound", () => Effect.succeed(guestProfile)))
```

## Data and Schema

### EFX-21: Untrusted data trusted by assertion

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/schema.md
**Do:** Decode data from requests, storage, files, and processes with `Schema.decodeUnknownEffect`, and derive the type from the schema.
**Avoid:** `as SomeType` on data from outside the process; a hand-written interface that duplicates a schema.
**Why?** An assertion checks nothing at run time, so a malformed payload travels deep into the program before it fails. The ESLint rule catches `JSON.parse`, but not an assertion on a value that another API has already parsed.

**(AVOID) Example:**
```ts
const body = (yield* request.json) as CreateProfile
```

**Correct Example:**
```ts
const body = yield* Schema.decodeUnknownEffect(CreateProfile)(yield* request.json)
```

## Resources and Concurrency

### EFX-24: Resource release that does not match the acquire

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/01_effect/05_resources/10_acquire-release.ts
**Do:** Make the release undo exactly what the acquire did, make it safe to run once on every exit, and log a release failure.
**Avoid:** A resource opened with a plain effect and closed manually; a release that ignores its own failure.
**Why?** `acquireRelease` runs the release on success, failure, and interruption. A manual close skips the release on an early failure. A release that fails silently leaks connections and file handles.

**(AVOID) Example:**
```ts
const conn = yield* openConnection(config)
const rows = yield* conn.query(sql)
yield* closeConnection(conn)
```

**Correct Example:**
```ts
const conn = yield* Effect.acquireRelease(openConnection(config), (c) =>
  closeConnection(c).pipe(Effect.catch((error) => Effect.logWarning("Connection close failed", error))),
)
const rows = yield* conn.query(sql)
```

### EFX-25: Fiber that outlives its purpose

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/forking.md
**Do:** Fork with `forkScoped` or `forkChild`, and join, await, or interrupt each fiber. Use `forkDetach` only with a written reason.
**Avoid:** A fiber stored in a mutable variable outside Effect; a `forkDetach` for work that belongs to a request or a service.
**Why?** A detached or leaked fiber continues after its owner stops, so it can write stale state and hold resources. A scoped fiber stops when its scope closes.

**(AVOID) Example:**
```ts
let poller: Fiber.Fiber<void> | undefined
const start = Effect.gen(function* () {
  poller = yield* Effect.forkDetach(pollInbox)
})
```

**Correct Example:**
```ts
// The poller stops when the layer's scope closes.
export const InboxPollerLayer = Layer.effectDiscard(Effect.forkScoped(pollInbox))
```

### EFX-26: Scope managed by hand

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/migration/scope.md
**Do:** Use `Effect.scoped` or a scoped layer. Use `Scope.make` with `Scope.provide` and `Scope.close` only when the scope must outlive one effect.
**Avoid:** `Scope.make` followed by a `Scope.close` that an early return or failure can skip.
**Why?** `Effect.scoped` closes the scope on every exit path. A manual close runs only on the path that reaches it.

**(AVOID) Example:**
```ts
const scope = yield* Scope.make()
const file = yield* openReportFile(path).pipe(Scope.provide(scope))
if (rows.length === 0) return emptyReport
yield* Scope.close(scope, Exit.void)
```

**Correct Example:**
```ts
const report = Effect.scoped(
  Effect.gen(function* () {
    const file = yield* openReportFile(path)
    if (rows.length === 0) return emptyReport
    return yield* writeReport(file, rows)
  }),
)
```

### EFX-27: Shared state updated with a race

**Reference:** https://effect.website/docs/state-management/ref/
**Do:** Use `Ref.modify`/`Ref.update` for read-then-write, `SynchronizedRef` for effectful updates, and `TxRef` for coordinated changes to several references.
**Avoid:** `Ref.get` followed by `Ref.set` that depends on the value read; a module-level mutable variable shared by fibers.
**Why?** Another fiber can run between the read and the write, so updates are lost. The defect is non-deterministic and rarely shows in tests.

**(AVOID) Example:**
```ts
const used = yield* Ref.get(slots)
if (used < max) yield* Ref.set(slots, used + 1)
```

**Correct Example:**
```ts
const reserved = yield* Ref.modify(slots, (used) => (used < max ? [true, used + 1] : [false, used]))
```

### EFX-28: Critical section that interruption can split

**Reference:** https://effect.website/docs/concurrency/basic-concurrency/#interruptions
**Do:** Wrap steps that must complete together in `Effect.uninterruptible`, or add compensation for a partial result.
**Avoid:** A multi-step external change (debit then credit, write then index) that can stop between steps.
**Why?** An interruption from a timeout, a race, or a scope close can stop the fiber between two steps and leave external state inconsistent.

**(AVOID) Example:**
```ts
const transfer = Effect.fn("Ledger.transfer")(function* (from: AccountId, to: AccountId, amount: Money) {
  yield* debit(from, amount)
  yield* credit(to, amount)
})
```

**Correct Example:**
```ts
const transfer = (from: AccountId, to: AccountId, amount: Money) =>
  Effect.uninterruptible(Effect.andThen(debit(from, amount), credit(to, amount)))
```

### EFX-29: Unbounded fan-out, retry, or wait

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/06_schedule/10_schedules.ts
**Do:** Set `concurrency` on `forEach`/`all`, limit retries, retry only errors that are safe to retry, and set a timeout on external calls.
**Avoid:** `{ concurrency: "unbounded" }` over input of unknown size; `Effect.retry` with no limit; a retry of a non-idempotent write.
**Why?** Unbounded work overloads dependencies. An unlimited retry turns an outage into a retry storm. A retried write that is not idempotent duplicates side effects.

**(AVOID) Example:**
```ts
yield* Effect.forEach(ids, fetchProfile, { concurrency: "unbounded" }).pipe(Effect.retry(Schedule.forever))
```

**Correct Example:**
```ts
yield* Effect.forEach(ids, fetchProfile, { concurrency: 8 }).pipe(
  Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis"), while: (error) => error._tag === "UpstreamFailed" }),
  Effect.timeout("30 seconds"),
)
```

### EFX-31: Resolver that cannot batch

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/05_batching/10_request-resolver.ts
**Do:** Give each resolver one data source and one set of services, so every request in a batch uses the same logic.
**Avoid:** A resolver that selects a service or API per request.
**Why?** Requests that need different context cannot batch, so the resolver makes one call per request and loses the benefit it exists for.

**(AVOID) Example:**
```ts
const resolveUser = (request: GetUser) =>
  request.region === "EU" ? euApi.getUser(request.id) : usApi.getUser(request.id)
```

**Correct Example:**
```ts
// One resolver per region; each batches its own requests through one API.
const EuUsers = makeUserResolver(euApi)
const UsUsers = makeUserResolver(usApi)
```

## Runtime Boundaries and Observability

### EFX-30: Effect run inside feature code

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/04_integration/10_managed-runtime.ts
**Do:** Run the program once at the process entry, or through one `ManagedRuntime` for framework callbacks.
**Avoid:** `Effect.runPromise` in a service, a helper, or a loop; a new runtime per request.
**Why?** Each run point splits interruption, typed errors, and resource ownership. A runtime per request rebuilds every layer. The linter guards `runSync` only; the other run functions need review.

**(AVOID) Example:**
```ts
export const handler = async (request: Request) =>
  Effect.runPromise(handleRequest(request).pipe(Effect.provide(AppLayer)))
```

**Correct Example:**
```ts
const runtime = ManagedRuntime.make(AppLayer)
export const handler = (request: Request) => runtime.runPromise(handleRequest(request))
```

### EFX-32: Log without context, or a secret in a log

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/08_observability/10_logging.ts
**Do:** Log with `Effect.logInfo`/`logWarning`/`logError`, add identifiers with `Effect.annotateLogs`, and keep secrets in `Redacted`.
**Avoid:** Values interpolated into the message string; `Redacted.value` passed to a log or an error.
**Why?** Structured fields are searchable in the log sink; interpolated text is not. An unwrapped secret in a log or an error payload leaks to every sink that receives it.

**(AVOID) Example:**
```ts
yield* Effect.logInfo(`Synced ${id} with token ${Redacted.value(token)}`)
```

**Correct Example:**
```ts
yield* Effect.logInfo("Profile synced").pipe(Effect.annotateLogs({ profileId: id }))
```

## Testing

### EFX-33: Test that replaces the implementation it claims to test

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/09_testing/20_layer-tests.ts
**Do:** Test through the public service API, and provide focused test layers at the service boundary.
**Avoid:** Broad or `globalThis` mocks; a copy of the production algorithm inside the test.
**Why?** A broad mock tests the mock. A duplicated algorithm passes when both copies share the same defect.

**(AVOID) Example:**
```ts
globalThis.fetch = async () => new Response(JSON.stringify(sampleProfile))
```

**Correct Example:**
```ts
const ProfileClientTest = Layer.succeed(ProfileClient, ProfileClient.of({ get: () => Effect.succeed(sampleProfile) }))
```

### EFX-34: Failure asserted without its tag

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/09_testing/10_effect-tests.ts
**Do:** Reach the failure with `Effect.flip` or `Exit`, and assert its `_tag` and fields.
**Avoid:** An assertion that only checks that the effect failed.
**Why?** A test that accepts any failure passes when the code fails for an unrelated reason, such as a missing layer.

**(AVOID) Example:**
```ts
const exit = yield* Effect.exit(loadProfile(missingId))
expect(Exit.isFailure(exit)).toBe(true)
```

**Correct Example:**
```ts
const error = yield* Effect.flip(loadProfile(missingId))
expect(error._tag).toBe("ProfileNotFound")
```

## Lint Exceptions

### EFX-36: Lint exception without scope or reason

**Reference:** https://github.com/Effect-TS/effect-smol/blob/main/LLMS.md
**Do:** Put a structural exception in scoped ESLint configuration. Allow an inline disable only for one line, with a category and a reason: (a) external API boundary, (b) foreign value domain, (c) pinned public contract, (d) confirmed false positive.
**Avoid:** A file-level or block disable; a disable without a reason; an edit to the rule set, `.oxlintrc.json`, or a language service severity to make a change pass; an evasion such as `as any` or `@ts-expect-error`.
**Why?** Each exception must be auditable. A change to the gate itself weakens every later review, and an evasion hides the same defect that the rule exists to find.

**(AVOID) Example:**
```ts
/* eslint-disable effect/no-null-use-option */
const encoded = { parentId: parent ?? null } as any
```

**Correct Example:**
```ts
// eslint-disable-next-line effect/no-null-use-option -- (b) the wire protocol encodes absence as JSON null
const encoded = { parentId: parent === undefined ? null : parent }
```

---

## Review Checklist

- [ ] EFX-17: Does each error channel list exactly the failures that can occur?
- [ ] EFX-14: Does any stateful layer depend on a fresh build that v4 memoization now shares?
- [ ] EFX-24, EFX-26: Is each resource released and each scope closed on every exit path?
- [ ] EFX-25: Is each forked fiber joined, awaited, interrupted, or scoped?
- [ ] EFX-27, EFX-28: Is shared state atomic, and is each critical section safe from interruption?
- [ ] EFX-30: Are Effect/Promise boundaries only at true entry points?
- [ ] EFX-18: Are defects and expected failures classified correctly?
- [ ] EFX-36: Is each lint exception scoped, categorised, and justified?
