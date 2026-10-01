---
Tech: Effect (TypeScript)
Version: 4.0.0-rc.117
Source: https://github.com/Effect-TS/effect-smol (LLMS.md, MIGRATION.md, migration/*.md)
Last Updated: 2026-09-30
---

# Effect v4 Development Standards

> Follow these standards when you create, implement, or refactor Effect code. The Effect
> ESLint bundle (v4, 54 rules), oxlint, and `@effect/language-service` already enforce the
> mechanical rules (Promise flow, throw, try/catch, `new Error`, null, `JSON.parse`, timers,
> `process.env`, `console`, `Date`, `fs`, legacy `Context.Tag`); they are not restated.
> Verify an unfamiliar API against the effect-smol source. Effect v3 examples are wrong here.

## Naming Conventions

### EFX-01: Name every effectful function with `Effect.fn` [IMPORTANT]
**Do:** Wrap a function that returns an Effect in `Effect.fn("Owner.method")`, and make the name match the function.
**Why:** The name becomes the tracing span and the stack-trace frame, so a failure points at the real call site.
**Example:**
```ts
export const loadProfile = Effect.fn("Profiles.load")(function* (id: ProfileId) {
  const profiles = yield* Profiles
  return yield* profiles.find(id)
})
```

### EFX-02: Give each service a path-shaped identifier [IMPORTANT]
**Do:** Pass a unique identifier that names the package and the module path.
**Why:** The identifier is the runtime key; a short generic name such as `"Config"` can collide across packages.
**Example:**
```ts
export class Profiles extends Context.Service<Profiles, ProfilesShape>()("app/profile/Profiles") {}
```

### EFX-03: Name layers `layer`, then add a suffix for variants [RECOMMENDED]
**Do:** Attach the primary layer as `static readonly layer`; name variants `layerTest`, `layerConfig`, `layerMemory`.
**Why:** v4 replaced the v3 `Default`/`Live` names with this convention, so readers find layers in one place.
**Example:**
```ts
export class Clock extends Context.Service<Clock, ClockShape>()("app/time/Clock") {
  static readonly layer = Layer.effect(this, makeClock)
  static readonly layerTest = Layer.succeed(this, Clock.of({ now: Effect.succeed(fixedInstant) }))
}
```

## File Structure

### EFX-04: Keep a service, its layer, and its errors in one module [RECOMMENDED]
**Do:** Put the service class, its static layers, and its tagged errors in the same file; export the shape as `X["Service"]` when other code needs the type.
**Why:** One module per service keeps the contract, the implementation, and the failure surface reviewable together.
**Example:**
```ts
export class Profiles extends Context.Service<Profiles, ProfilesShape>()("app/profile/Profiles") {}
export class ProfileNotFound extends Schema.TaggedErrorClass<ProfileNotFound>()("ProfileNotFound", { id: ProfileId }) {}
export type ProfilesService = Profiles["Service"]
```

### EFX-05: Import stable modules from `effect` and unstable modules by path [RECOMMENDED]
**Do:** Import core modules from the `effect` barrel; import HTTP, CLI, process, and AI modules from `effect/unstable/*`.
**Why:** v4 merged the platform packages into `effect`; the `unstable` path marks APIs that can still change.
**Example:**
```ts
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
```

## Effects and Functions

### EFX-06: Pass extra behaviour to `Effect.fn` as arguments [IMPORTANT]
**Do:** Add spans, log annotations, and recovery as extra arguments to `Effect.fn`, not with `.pipe` on the result.
**Why:** The extra arguments run inside the named span; a trailing `.pipe` wraps the function, not each call.
**Example:**
```ts
export const syncProfile = Effect.fn("Profiles.sync")(
  function* (id: ProfileId) {
    const client = yield* ProfileClient
    return yield* client.push(id)
  },
  Effect.annotateLogs({ operation: "sync" }),
)
```

### EFX-07: Keep synchronous logic synchronous [IMPORTANT]
**Do:** Return a plain value from parsing, option building, and pure computation; return an Effect only for effectful work.
**Why:** A needless Effect adds allocation, hides the pure contract, and forces every caller into a generator.
**Example:**
```ts
const toQuery = (filter: ProfileFilter) => ({ status: filter.status, limit: filter.limit ?? 50 })
```

### EFX-08: Write `return yield*` when a generator fails [IMPORTANT]
**Do:** Fail with `return yield* new SomeError(...)` or `return yield* Effect.fail(...)`.
**Why:** The `return` tells TypeScript that the generator stops, so later code narrows correctly.
**Example:**
```ts
const requireActive = Effect.fn("Profiles.requireActive")(function* (profile: Profile) {
  if (profile.status !== "active") return yield* new ProfileInactive({ id: profile.id })
  return profile
})
```

### EFX-09: Use the v4 combinator names [CRITICAL]
**Do:** Use `Effect.catch`, `catchCause`, `catchDefect`, `catchFilter`, `result`, `callback`, `forkChild`, `forkDetach`, `tapCause`, `Scope.provide`, and `Layer.effect` for scoped layers.
**Why:** v4 renamed or removed the v3 forms (`catchAll`, `either`, `async`, `fork`, `forkDaemon`, `Layer.scoped`, `Scope.extend`).
**Example:**
```ts
const outcome = yield* fetchProfile(id).pipe(Effect.result)
const worker = yield* Effect.forkChild(pollInbox)
const safe = loadConfig.pipe(Effect.catch(() => Effect.succeed(defaultConfig)))
```

### EFX-10: Read `Ref`, `Deferred`, and `Fiber` through their modules [IMPORTANT]
**Do:** Call `Ref.get`, `Deferred.await`, and `Fiber.join`; call `.asEffect()` to pass a Yieldable (`Option`, `Result`, `Config`, a service) to a combinator.
**Why:** v4 removed Effect subtyping; these values are no longer Effects, and only `yield*` accepts a Yieldable directly.
**Example:**
```ts
const count = yield* Ref.get(counter)
const result = yield* Fiber.join(worker)
const port = yield* Effect.orElseSucceed(Config.port("PORT").asEffect(), () => 8080)
```

## Services and Layers

### EFX-11: Read a service with `yield*` into a named variable [IMPORTANT]
**Do:** Bind the service to a named variable with `yield*`, then call its methods.
**Why:** The dependency stays visible at the call site; `Service.use(...)` hides it and can leak requirements.
**Example:**
```ts
const notify = Effect.fn("Alerts.notify")(function* (message: string) {
  const notifications = yield* Notifications
  yield* notifications.send(message)
})
```

### EFX-12: Build each layer explicitly and wire its dependencies [IMPORTANT]
**Do:** Build a layer with `Layer.effect(Service, make)` and wire dependencies with `Layer.provide`; return the implementation through `Service.of`.
**Why:** v4 `make` does not generate a layer and has no `dependencies` option; the graph must be written out.
**Example:**
```ts
export class Profiles extends Context.Service<Profiles, ProfilesShape>()("app/profile/Profiles") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const repository = yield* ProfileRepository
      const find = Effect.fn("Profiles.find")(function* (id: ProfileId) {
        return yield* repository.find(id)
      })
      return Profiles.of({ find })
    }),
  ).pipe(Layer.provide(ProfileRepository.layer))
}
```

### EFX-13: Compose layers once at the application edge [IMPORTANT]
**Do:** Merge and provide the full layer graph at the entry point, one time.
**Why:** One composition point shows the whole graph and keeps missing dependencies visible to the type checker.
**Example:**
```ts
const AppLayer = Layer.mergeAll(Profiles.layer, Notifications.layer).pipe(Layer.provide(Database.layer))
const main = program.pipe(Effect.provide(AppLayer))
```

### EFX-14: Request a fresh layer on purpose when state must not be shared [CRITICAL]
**Do:** Use `Layer.fresh(layer)` or `Effect.provide(layer, { local: true })` for a per-use instance, and state why at the site.
**Why:** v4 shares one `MemoMap` across `Effect.provide` calls, so a stateful layer is shared by default.
**Example:**
```ts
// Each tenant must get its own pool.
const runForTenant = (tenant: TenantId) =>
  handleTenant(tenant).pipe(Effect.provide(ConnectionPool.layer, { local: true }))
```

### EFX-15: Keep each service small and cohesive [RECOMMENDED]
**Do:** Give each service one responsibility and give its methods names specific to that domain.
**Why:** Small services are easier to replace in tests and to recompose; two services with the same structure are easy to confuse.
**Example:**
```ts
class Mailer extends Context.Service<Mailer, { readonly send: (mail: Mail) => Effect.Effect<void, MailRejected> }>()("app/mail/Mailer") {}
```

## Errors

### EFX-16: Model expected failures with `Schema.TaggedErrorClass` [IMPORTANT]
**Do:** Define domain errors with `Schema.TaggedErrorClass`, with the fields a handler needs; use `Schema.Defect()` for a wrapped cause.
**Why:** Schema errors are serialisable across HTTP and RPC boundaries and carry typed, inspectable context.
**Example:**
```ts
export class UpstreamFailed extends Schema.TaggedErrorClass<UpstreamFailed>()("UpstreamFailed", {
  service: Schema.String,
  cause: Schema.Defect(),
}) {}
```

### EFX-17: Keep the error channel precise [CRITICAL]
**Do:** Declare the exact union of tagged errors that a function can fail with, with `Effect.fn.Return<A, E>` when you annotate.
**Why:** Callers can only handle what the type shows; a widened channel hides the failures that matter.
**Example:**
```ts
const load = Effect.fn("Profiles.load")(function* (id: ProfileId): Effect.fn.Return<Profile, ProfileNotFound | UpstreamFailed> {
  const profiles = yield* Profiles
  return yield* profiles.find(id)
})
```

### EFX-18: Fail for recoverable outcomes, die for broken invariants [CRITICAL]
**Do:** Use `Effect.fail` when a caller can recover; use `Effect.die` only when the failure is a programming defect.
**Why:** A caller cannot catch a defect, and a failure that should be a defect makes bugs look like handled errors.
**Example:**
```ts
const decodeRow = (row: unknown) =>
  Schema.decodeUnknownEffect(ProfileRow)(row).pipe(Effect.mapError((cause) => new CorruptRow({ cause })))
```

### EFX-19: Convert foreign failures to tagged errors at the boundary [IMPORTANT]
**Do:** Wrap a Promise API in `Effect.tryPromise({ try, catch })` and a throwing call in `Effect.try`, and map to a tagged error.
**Why:** Code after the boundary sees one typed failure, not an unknown value.
**Example:**
```ts
const fetchRemote = (id: ProfileId) =>
  Effect.tryPromise({
    try: (signal) => sdk.profiles.get(id, { signal }),
    catch: (cause) => new UpstreamFailed({ service: "profiles", cause }),
  })
```

### EFX-20: Recover by tag, not with a blanket catch [RECOMMENDED]
**Do:** Use `Effect.catchTag`, `catchTags`, or `catchReason` for the failures you intend to handle.
**Why:** A targeted handler leaves unexpected failures in the channel, where the type shows them.
**Example:**
```ts
const withDefault = load(id).pipe(Effect.catchTag("ProfileNotFound", () => Effect.succeed(guestProfile)))
```

## Data and Schema

### EFX-21: Decode untrusted data with a schema at the boundary [CRITICAL]
**Do:** Decode request bodies, rows, files, and environment data with `Schema.decodeUnknownEffect`, and derive the type from the schema.
**Why:** A type assertion checks nothing at run time; a schema proves the shape once, where the data enters.
**Example:**
```ts
export const ProfileRow = Schema.Struct({ id: ProfileId, name: Schema.String, status: Schema.Literals(["active", "inactive"]) })
export type ProfileRow = typeof ProfileRow.Type
const row = yield* Schema.decodeUnknownEffect(ProfileRow)(raw)
```

### EFX-22: Use `Result` and `Option` for values that carry outcome or absence [RECOMMENDED]
**Do:** Use `Result` (the v4 name for `Either`) for a value that can hold a failure, and `Option` for absence.
**Why:** Both are Yieldable, so a generator can unwrap them with `yield*` and keep the failure typed.
**Example:**
```ts
const parsed: Result.Result<Port, InvalidPort> = parsePort(input)
const port = yield* parsed
```

### EFX-23: Use the `Predicate` module for runtime guards [RECOMMENDED]
**Do:** Use `Predicate.isObject`, `isString`, and the composition helpers instead of a hand-written guard.
**Why:** The shared guards are tested and narrow types consistently.
**Example:**
```ts
if (Predicate.isObject(payload) && Predicate.isString(payload.id)) return payload.id
```

## Resources and Concurrency

### EFX-24: Pair every acquire with a release that cannot fail silently [CRITICAL]
**Do:** Use `Effect.acquireRelease` with a release that undoes exactly what the acquire did, and log a release failure.
**Why:** The release runs on success, failure, and interruption; a release that fails silently leaks the resource.
**Example:**
```ts
const connection = Effect.acquireRelease(openConnection(config), (conn) =>
  closeConnection(conn).pipe(Effect.catch((error) => Effect.logWarning("Connection close failed", error))),
)
```

### EFX-25: Tie each fiber to a scope or a parent [CRITICAL]
**Do:** Fork with `Effect.forkScoped` or `forkChild`, and join, await, or interrupt each fiber; use `forkDetach` only with a written reason.
**Why:** A detached fiber outlives its caller and keeps running after the work it served has ended.
**Example:**
```ts
const withHeartbeat = Effect.scoped(Effect.andThen(Effect.forkScoped(heartbeat), mainTask))
```

### EFX-26: Let `Effect.scoped` close scopes [IMPORTANT]
**Do:** Use `Effect.scoped` or a scoped layer; use `Scope.make` with `Scope.provide` only when the scope must outlive one effect.
**Why:** `Effect.scoped` closes the scope on every exit path, including early returns and interruption.
**Example:**
```ts
const report = Effect.scoped(
  Effect.gen(function* () {
    const file = yield* openReportFile(path)
    return yield* writeReport(file, rows)
  }),
)
```

### EFX-27: Update shared state atomically [CRITICAL]
**Do:** Use `Ref.update` or `Ref.modify` for read-then-write, `SynchronizedRef` for effectful updates, and `TxRef` for coordinated changes to several references.
**Why:** A separate `get` then `set` loses updates when two fibers interleave.
**Example:**
```ts
const reserveSlot = (slots: Ref.Ref<number>, max: number) =>
  Ref.modify(slots, (used) => (used < max ? [true, used + 1] : [false, used]))
```

### EFX-28: Protect multi-step critical sections from interruption [IMPORTANT]
**Do:** Wrap steps that must complete together in `Effect.uninterruptible`, or add compensation for partial completion.
**Why:** Interruption can stop a fiber between two steps and leave external state inconsistent.
**Example:**
```ts
const transfer = (from: AccountId, to: AccountId, amount: Money) =>
  Effect.uninterruptible(Effect.andThen(debit(from, amount), credit(to, amount)))
```

### EFX-29: Bound concurrency, retries, and waits [IMPORTANT]
**Do:** Set `concurrency` on `Effect.forEach`/`all`, retry only errors that are safe to retry with a limit, and set an explicit timeout.
**Why:** Unbounded fan-out and retries overload dependencies; a missing timeout lets one stalled call block a fiber.
**Example:**
```ts
const results = yield* Effect.forEach(ids, fetchProfile, { concurrency: 8 }).pipe(
  Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis"), while: (error) => error._tag === "UpstreamFailed" }),
  Effect.timeout("30 seconds"),
)
```

## Runtime Boundaries and Observability

### EFX-30: Run effects only at a true entry point [IMPORTANT]
**Do:** Run the program once at the process entry, or build one `ManagedRuntime` from the application layer for framework callbacks.
**Why:** Each extra run point splits interruption, typed errors, and resource ownership.
**Example:**
```ts
const runtime = ManagedRuntime.make(AppLayer)
export const handler = (request: Request) => runtime.runPromise(handleRequest(request))
```

### EFX-31: Capture the context when you must run from a callback [IMPORTANT]
**Do:** Read the services with `Effect.context<R>()` and run with `Effect.runForkWith(services)`.
**Why:** v4 removed `Runtime<R>`; the captured context keeps the callback on the same services.
**Example:**
```ts
const subscribe = Effect.gen(function* () {
  const services = yield* Effect.context<Notifications>()
  emitter.on("change", (event) => Effect.runForkWith(services)(onChange(event)))
})
```

### EFX-32: Log and trace through Effect with structured context [IMPORTANT]
**Do:** Log with `Effect.logInfo`/`logWarning`/`logError`, add fields with `Effect.annotateLogs`, and wrap secrets in `Redacted`.
**Why:** Structured fields and spans reach the configured sinks; a `Redacted` value prints as `<redacted>`.
**Example:**
```ts
yield* Effect.logInfo("Profile synced").pipe(Effect.annotateLogs({ profileId: id, attempt }))
```

## Testing

### EFX-33: Test through the public service API with explicit layers [IMPORTANT]
**Do:** Provide a test layer built with `Layer.succeed` or a focused mock at the service boundary, and keep the provision visible in the test.
**Why:** The test exercises the real program; broad or global mocks test the mock.
**Example:**
```ts
const ProfilesTest = Layer.succeed(Profiles, Profiles.of({ find: () => Effect.succeed(sampleProfile) }))
const exit = await Effect.runPromiseExit(loadProfile(sampleId).pipe(Effect.provide(ProfilesTest)))
```

### EFX-34: Assert failures by tag [IMPORTANT]
**Do:** Use `Effect.flip` or `Exit` to reach the failure and assert its `_tag` and fields.
**Why:** A test that only checks "it failed" passes for the wrong reason.
**Example:**
```ts
const error = yield* Effect.flip(loadProfile(missingId))
expect(error._tag).toBe("ProfileNotFound")
```

### EFX-35: Use live tests for real platform behaviour [RECOMMENDED]
**Do:** Run filesystem, git, process, socket, and real-time tests in live mode with scoped fixtures and finalizers.
**Why:** The test clock and fake services cannot show platform timing, and finalizers remove temporary state.
**Example:**
```ts
const withTempDir = Effect.acquireRelease(makeTempDir, (dir) => removeDir(dir).pipe(Effect.orDie))
```

## Lint Exceptions

### EFX-36: Scope an exception in configuration, or justify it in one line [CRITICAL]
**Do:** Put a structural exception in scoped ESLint configuration; write an inline disable only for one line, with the category and the reason.
**Why:** Categories (a) external API boundary, (b) foreign value domain, (c) pinned public contract, and (d) confirmed false positive make each exception auditable.
**Example:**
```ts
// eslint-disable-next-line effect/no-null-use-option -- (b) the wire protocol encodes absence as JSON null
const encoded = { parentId: parent === undefined ? null : parent }
```
