export * as SystemContext from "./index"

import { Data, Effect, HashSet, MutableHashSet, Option, Schema } from "effect"

/**
 * Models privileged system context as independently refreshable typed sources.
 *
 * `Source<A>` describes how to observe, compare, and render one value. `make`
 * closes over `A`, producing an opaque `SystemContext` that composes uniformly
 * with contexts built from other value types. Interpreters observe the composed
 * context once, then produce a durable structured
 * `Snapshot` alongside the exact model-visible baseline or update text.
 *
 * Returning `unavailable` means observation failed temporarily. It differs from
 * removing a source from the context: refresh preserves the admitted snapshot,
 * and replacement waits rather than silently constructing an incomplete baseline.
 *
 * @module
 */

/** Stable namespaced identity for one independently refreshable context source. */
export const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/)).pipe(
  Schema.brand("SystemContext.Key"),
)
export type Key = typeof Key.Type

/** Indicates that a source could not be observed without treating it as removed. */
export const unavailable = Symbol.for("@opencode/SystemContext.Unavailable")
export type Unavailable = typeof unavailable

/** Defines one typed source before its value type is hidden by `make`. */
export interface Source<A> {
  readonly key: Key
  readonly codec: Schema.Codec<A, Schema.Json, never, never>
  readonly load: Effect.Effect<A | Unavailable>
  readonly baseline: (current: A) => string
  readonly update: (previous: A, current: A) => string
  readonly removed?: (previous: A) => string
}

const ContextTypeId: unique symbol = Symbol.for("@opencode/SystemContext")

/** Opaque carrier for composable system context sources. */
export interface SystemContext {
  readonly [ContextTypeId]: ReadonlyArray<PackedSource>
}

/** Durable comparison state for one admitted source. */
export const SourceSnapshot = Schema.Struct({
  value: Schema.Json,
  removed: Schema.optional(Schema.NonEmptyString),
}).annotate({ identifier: "SystemContext.SourceSnapshot" })
export type SourceSnapshot = typeof SourceSnapshot.Type

/** Durable structured comparison state for one active context generation. */
export const Snapshot = Schema.Record(Schema.String, SourceSnapshot).check(
  Schema.makeFilter((snapshot) =>
    Object.keys(snapshot).every(Schema.is(Key)) ? undefined : "Expected namespaced system context keys",
  ),
)
export type Snapshot = Readonly<Record<string, SourceSnapshot>>

export interface Generation {
  readonly baseline: string
  readonly snapshot: Snapshot
}

/** Outcome of comparing current source values with one active generation. */
export type ReconcileResult = Data.TaggedEnum<{
  Unchanged: {}
  Updated: { readonly text: string; readonly snapshot: Snapshot }
  ReplacementReady: { readonly generation: Generation }
  ReplacementBlocked: {}
}>
export const ReconcileResult = Data.taggedEnum<ReconcileResult>()
export type Updated = Data.TaggedEnum.Value<ReconcileResult, "Updated">
export type ReplacementReady = Data.TaggedEnum.Value<ReconcileResult, "ReplacementReady">
export type ReplacementBlocked = Data.TaggedEnum.Value<ReconcileResult, "ReplacementBlocked">
export type ReplacementResult = ReplacementReady | ReplacementBlocked

export class InitializationBlocked extends Schema.TaggedError<InitializationBlocked>()(
  "SystemContext.InitializationBlocked",
  { keys: Schema.Array(Key) },
) {
  override get message() {
    return `System context initialization blocked by unavailable sources: ${this.keys.join(", ")}`
  }
}

export class DuplicateKeyError extends Schema.TaggedError<DuplicateKeyError>()("SystemContext.DuplicateKeyError", {
  key: Key,
}) {
  override get message() {
    return `Duplicate system context key: ${this.key}`
  }
}

/** Model-visible text that a source renders. Each kind must not be empty. */
export const RenderingKind = Schema.Literals(["baseline", "update", "removal"])
export type RenderingKind = typeof RenderingKind.Type

/** A source broke its contract and rendered empty model-visible text. It is raised as a defect. */
export class EmptyRenderingError extends Schema.TaggedError<EmptyRenderingError>()(
  "SystemContext.EmptyRenderingError",
  { key: Key, kind: RenderingKind },
) {
  override get message() {
    return `System context source ${this.key} rendered an empty ${this.kind}`
  }
}

interface PackedSource {
  readonly key: Key
  readonly load: Effect.Effect<Loaded | Unavailable>
}

interface Loaded {
  readonly baseline: Effect.Effect<Rendered>
  readonly compare: (previous: Schema.Json) => Compared
}

interface Rendered {
  readonly text: string
  readonly snapshot: SourceSnapshot
}

type Compared = Data.TaggedEnum<{
  Incompatible: {}
  Unchanged: {}
  Updated: { readonly render: Effect.Effect<Rendered> }
}>
const Compared = Data.taggedEnum<Compared>()

type Entry = Data.TaggedEnum<{
  Available: {
    readonly key: Key
    readonly baseline: Effect.Effect<Rendered>
    readonly compare: (previous: Schema.Json) => Compared
  }
  Unavailable: { readonly key: Key }
}>
const Entry = Data.taggedEnum<Entry>()

/** One observed source's part of the next snapshot, planned before any update text is rendered. */
type Step = Data.TaggedEnum<{
  Keep: { readonly key: Key; readonly snapshot: SourceSnapshot }
  Render: { readonly key: Key; readonly render: Effect.Effect<Rendered> }
}>
const Step = Data.taggedEnum<Step>()

/** The identity context. */
export const empty = context([])

/** Closes a typed source into a context that composes with differently typed sources. */
export function make<A>(source: Source<A>): SystemContext {
  const decode = Schema.decodeUnknownOption(source.codec)
  const encode = Schema.encodeSync(source.codec)
  const equivalent = Schema.toEquivalence(source.codec)
  return context([
    {
      key: source.key,
      load: source.load.pipe(
        Effect.map((value) => {
          if (isUnavailable(value)) return value
          const snapshot = Effect.suspend((): Effect.Effect<SourceSnapshot> => {
            const encoded = encode(value)
            if (!source.removed) return Effect.succeed({ value: encoded })
            return requireText(source.key, "removal", source.removed(value)).pipe(
              Effect.map((removed) => ({ value: encoded, removed })),
            )
          })
          const rendered = (kind: RenderingKind, text: () => string): Effect.Effect<Rendered> =>
            Effect.suspend(() => requireText(source.key, kind, text())).pipe(
              Effect.flatMap((text) => Effect.map(snapshot, (snapshot) => ({ text, snapshot }))),
            )
          return {
            baseline: rendered("baseline", () => source.baseline(value)),
            compare: (previous): Compared =>
              Option.match(decode(previous), {
                onNone: () => Compared.Incompatible(),
                onSome: (decoded) =>
                  equivalent(decoded, value)
                    ? Compared.Unchanged()
                    : Compared.Updated({ render: rendered("update", () => source.update(decoded, value)) }),
              }),
          }
        }),
      ),
    },
  ])
}

/** Combines contexts in order and rejects duplicate source keys immediately. */
export function combine(values: ReadonlyArray<SystemContext>): SystemContext {
  const sources = values.flatMap((value) => value[ContextTypeId])
  assertUniqueKeys(sources)
  return context(sources)
}

const observe = (value: SystemContext) =>
  Effect.forEach(
    value[ContextTypeId],
    (source) =>
      source.load.pipe(
        Effect.map(
          (result): Entry =>
            result === unavailable
              ? Entry.Unavailable({ key: source.key })
              : Entry.Available({ key: source.key, ...result }),
        ),
      ),
    { concurrency: "unbounded" },
  )

/** Creates the immutable baseline and durable snapshot for a new generation. */
export function initialize(value: SystemContext): Effect.Effect<Generation, InitializationBlocked> {
  return observe(value).pipe(
    Effect.flatMap((entries) => {
      const unavailable = entries.flatMap((entry) => (entry._tag === "Unavailable" ? [entry.key] : []))
      if (unavailable.length > 0) return new InitializationBlocked({ keys: unavailable })
      return initializeObservation(entries)
    }),
  )
}

function initializeObservation(entries: ReadonlyArray<Entry>): Effect.Effect<Generation> {
  return Effect.forEach(entries.filter(Entry.$is("Available")), (entry) =>
    Effect.map(entry.baseline, (rendered) => [entry.key, rendered] as const),
  ).pipe(
    Effect.map((rendered) => ({
      baseline: render(rendered.map(([, result]) => result.text)),
      snapshot: Object.fromEntries(rendered.map(([key, result]) => [key, result.snapshot])),
    })),
  )
}

/** Reconciles current source values with one active generation. */
export function reconcile(value: SystemContext, previous: Snapshot): Effect.Effect<ReconcileResult> {
  return observe(value).pipe(Effect.flatMap((entries) => reconcileObservation(entries, previous)))
}

function reconcileObservation(entries: ReadonlyArray<Entry>, previous: Snapshot): Effect.Effect<ReconcileResult> {
  const plan = Option.all(entries.map((entry) => planEntry(entry, getSnapshot(previous, entry.key)))).pipe(
    Option.flatMap((steps) => Option.map(removals(entries, previous), (removed) => ({ steps: steps.flat(), removed }))),
  )
  if (Option.isNone(plan)) return replaceObservation(entries, previous)
  const removed = plan.value.removed
  return Effect.forEach(plan.value.steps, (step) =>
    Step.$match(step, {
      Keep: (kept) => Effect.succeed({ key: kept.key, snapshot: kept.snapshot, text: Option.none<string>() }),
      Render: (pending) =>
        Effect.map(pending.render, (rendered) => ({
          key: pending.key,
          snapshot: rendered.snapshot,
          text: Option.some(rendered.text),
        })),
    }),
  ).pipe(
    Effect.map((resolved): ReconcileResult => {
      const updates = [...resolved.flatMap((item) => Option.toArray(item.text)), ...removed]
      if (updates.length === 0) return ReconcileResult.Unchanged()
      return ReconcileResult.Updated({
        text: render(updates),
        snapshot: Object.fromEntries(resolved.map((item) => [item.key, item.snapshot])),
      })
    }),
  )
}

/** Plans one observed source. `None` means its stored value no longer decodes, so the generation is replaced. */
function planEntry(entry: Entry, stored: Option.Option<SourceSnapshot>): Option.Option<ReadonlyArray<Step>> {
  if (entry._tag === "Unavailable")
    return Option.some(Option.toArray(Option.map(stored, (snapshot) => Step.Keep({ key: entry.key, snapshot }))))
  if (Option.isNone(stored)) return Option.some([Step.Render({ key: entry.key, render: entry.baseline })])
  return Compared.$match(entry.compare(stored.value.value), {
    Incompatible: () => Option.none(),
    Unchanged: () => Option.some([Step.Keep({ key: entry.key, snapshot: stored.value })]),
    Updated: (compared) => Option.some([Step.Render({ key: entry.key, render: compared.render })]),
  })
}

/** Removal texts of admitted sources that left the context, in key order. `None` when one has no removal text. */
function removals(entries: ReadonlyArray<Entry>, previous: Snapshot): Option.Option<ReadonlyArray<string>> {
  const present = HashSet.fromIterable(entries.map((entry) => entry.key))
  return Option.all(
    Object.keys(previous)
      .sort()
      .filter((key) => !HashSet.has(present, Key.make(key)))
      .map((key) => Option.fromUndefinedOr(previous[key].removed)),
  )
}

/** Creates a complete replacement generation or blocks while admitted context is unavailable. */
export function replace(value: SystemContext, previous: Snapshot): Effect.Effect<ReplacementResult> {
  return observe(value).pipe(Effect.flatMap((entries) => replaceObservation(entries, previous)))
}

function replaceObservation(entries: ReadonlyArray<Entry>, previous: Snapshot): Effect.Effect<ReplacementResult> {
  if (entries.some((entry) => entry._tag === "Unavailable" && Option.isSome(getSnapshot(previous, entry.key))))
    return Effect.succeed(ReconcileResult.ReplacementBlocked())
  return initializeObservation(entries).pipe(
    Effect.map((generation) => ReconcileResult.ReplacementReady({ generation })),
  )
}

function context(sources: ReadonlyArray<PackedSource>): SystemContext {
  return { [ContextTypeId]: sources }
}

function render(parts: ReadonlyArray<string>) {
  return parts.join("\n\n")
}

function getSnapshot(snapshot: Snapshot, key: Key): Option.Option<SourceSnapshot> {
  return Object.hasOwn(snapshot, key) ? Option.some(snapshot[key]) : Option.none()
}

function isUnavailable(value: unknown): value is Unavailable {
  return value === unavailable
}

function requireText(key: Key, kind: RenderingKind, text: string): Effect.Effect<string> {
  return text.length === 0 ? Effect.die(new EmptyRenderingError({ key, kind })) : Effect.succeed(text)
}

function assertUniqueKeys(sources: ReadonlyArray<PackedSource>) {
  const keys = MutableHashSet.empty<Key>()
  for (const source of sources) {
    if (MutableHashSet.has(keys, source.key)) throw new DuplicateKeyError({ key: source.key })
    MutableHashSet.add(keys, source.key)
  }
}
