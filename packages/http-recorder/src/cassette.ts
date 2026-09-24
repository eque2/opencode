import { NodeCrypto } from "@effect/platform-node"
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { encodeJson } from "./matching.js"
import { secretFindings, SecretFindingSchema, type SecretFinding } from "./redaction.js"
import {
  CassetteMetadataSchema,
  CassetteSchema,
  type Cassette,
  type CassetteMetadata,
  type Interaction,
} from "./schema.js"

const DEFAULT_RECORDINGS_DIR = path.resolve(process.cwd(), "test", "fixtures", "recordings")

export class CassetteNotFoundError extends Schema.TaggedError<CassetteNotFoundError>()("CassetteNotFoundError", {
  cassetteName: Schema.String,
}) {
  override get message() {
    return `Cassette "${this.cassetteName}" not found`
  }
}

export class UnsafeCassetteError extends Schema.TaggedError<UnsafeCassetteError>()("UnsafeCassetteError", {
  cassetteName: Schema.String,
  findings: Schema.Array(SecretFindingSchema),
}) {
  override get message() {
    return `Refusing to write cassette "${this.cassetteName}" because it contains possible secrets: ${this.findings
      .map((finding) => `${finding.path} (${finding.reason})`)
      .join(", ")}`
  }
}

export class InvalidCassetteNameError extends Schema.TaggedError<InvalidCassetteNameError>()(
  "InvalidCassetteNameError",
  { cassetteName: Schema.String },
) {
  override get message() {
    return `Invalid cassette name "${this.cassetteName}"`
  }
}

export interface Interface {
  readonly read: (name: string) => Effect.Effect<ReadonlyArray<Interaction>, CassetteNotFoundError>
  readonly append: (
    name: string,
    interaction: Interaction,
    metadata?: CassetteMetadata,
  ) => Effect.Effect<void, UnsafeCassetteError>
  readonly exists: (name: string) => Effect.Effect<boolean>
  readonly list: () => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/http-recorder/Cassette") {}

const cassettePath = (directory: string, name: string): Result.Result<string, InvalidCassetteNameError> => {
  const invalid = () => Result.fail(new InvalidCassetteNameError({ cassetteName: name }))
  if (!name || path.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]/).includes(".."))
    return invalid()
  const root = path.resolve(directory)
  const target = path.resolve(root, `${name}.json`)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return invalid()
  return Result.succeed(target)
}

export const hasCassetteSync = (name: string, options: { readonly directory?: string } = {}) =>
  fs.existsSync(Result.getOrThrow(cassettePath(options.directory ?? DEFAULT_RECORDINGS_DIR, name)))

// Round-trip metadata through JSON so the stored value is exactly what the
// cassette file holds: undefined fields drop and toJSON values serialize.
const normalizeMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(CassetteMetadataSchema))

const buildCassette = (
  name: string,
  interactions: ReadonlyArray<Interaction>,
  metadata: CassetteMetadata | undefined,
  recordedAt: string,
): Cassette => ({
  version: 1,
  metadata: normalizeMetadata(encodeJson({ name, recordedAt, ...metadata })),
  interactions,
})

const encodeCassetteJson = Schema.encodeSync(Schema.fromJsonString(CassetteSchema, { space: 2 }))

const formatCassette = (cassette: Cassette) => `${encodeCassetteJson(cassette)}\n`

const parseCassette = Schema.decodeUnknownSync(Schema.fromJsonString(CassetteSchema))

const failIfUnsafe = (name: string, findings: ReadonlyArray<SecretFinding>) =>
  findings.length === 0 ? Effect.void : Effect.fail(new UnsafeCassetteError({ cassetteName: name, findings }))

export const fileSystem = (
  options: { readonly directory?: string } = {},
): Layer.Layer<Service, never, FileSystem.FileSystem> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const cryptoService = yield* Crypto.Crypto
      const directory = options.directory ?? DEFAULT_RECORDINGS_DIR
      const recorded = yield* Ref.make(
        HashMap.empty<
          string,
          { readonly interactions: ReadonlyArray<Interaction>; readonly findings: ReadonlyArray<SecretFinding> }
        >(),
      )
      const appendLock = yield* Semaphore.make(1)

      const pathFor = (name: string) => Effect.fromResult(cassettePath(directory, name)).pipe(Effect.orDie)

      const walk = (current: string): Effect.Effect<ReadonlyArray<string>> =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectory(current).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          const nested = yield* Effect.forEach(entries, (entry) => {
            const full = path.join(current, entry)
            return fs.stat(full).pipe(
              Effect.flatMap((stat) => (stat.type === "Directory" ? walk(full) : Effect.succeed([full]))),
              Effect.catch(() => Effect.succeed([] as string[])),
            )
          })
          return nested.flat()
        })

      return Service.of({
        read: (name) =>
          pathFor(name).pipe(
            Effect.flatMap((target) =>
              fs.readFileString(target).pipe(
                Effect.map((raw) => parseCassette(raw).interactions),
                Effect.catch(() => Effect.fail(new CassetteNotFoundError({ cassetteName: name }))),
              ),
            ),
          ),
        append: (name, interaction, metadata) =>
          appendLock.withPermit(
            Effect.gen(function* () {
              const entry = Option.getOrElse(HashMap.get(yield* Ref.get(recorded), name), () => ({
                interactions: [],
                findings: [],
              }))
              const interactions = [...entry.interactions, interaction]
              const interactionFindings = [...entry.findings, ...secretFindings(interaction)]
              const cassette = buildCassette(name, interactions, metadata, DateTime.formatIso(yield* DateTime.now))
              const findings = [...interactionFindings, ...secretFindings(cassette.metadata ?? {})]
              yield* failIfUnsafe(name, findings)
              const target = yield* pathFor(name)
              yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orDie)
              const temporary = `${target}.${yield* cryptoService.randomUUIDv4.pipe(Effect.orDie)}.tmp`
              yield* fs.writeFileString(temporary, formatCassette(cassette)).pipe(
                Effect.flatMap(() => fs.rename(temporary, target)),
                Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))),
                Effect.orDie,
              )
              yield* Ref.update(recorded, (entries) =>
                HashMap.set(entries, name, { interactions, findings: interactionFindings }),
              )
            }),
          ),
        exists: (name) =>
          pathFor(name).pipe(
            Effect.flatMap((target) =>
              fs.access(target).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              ),
            ),
          ),
        list: () =>
          walk(directory).pipe(
            Effect.map((files) =>
              files
                .filter((file) => file.endsWith(".json"))
                .map((file) =>
                  path
                    .relative(directory, file)
                    .replace(/\\/g, "/")
                    .replace(/\.json$/, ""),
                )
                .toSorted((a, b) => a.localeCompare(b)),
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(NodeCrypto.layer))

export const memory = (initial: Record<string, ReadonlyArray<Interaction>> = {}): Layer.Layer<Service> =>
  Layer.sync(Service, () => {
    const stored = Ref.makeUnsafe(
      HashMap.fromIterable(
        Object.entries(initial).map(([name, interactions]): readonly [string, ReadonlyArray<Interaction>] => [
          name,
          [...interactions],
        ]),
      ),
    )
    const accumulatedFindings = Ref.makeUnsafe(HashMap.empty<string, ReadonlyArray<SecretFinding>>())
    const appendLock = Semaphore.makeUnsafe(1)

    return Service.of({
      read: (name) =>
        Ref.get(stored).pipe(
          Effect.flatMap((cassettes) =>
            Option.match(HashMap.get(cassettes, name), {
              onNone: () => Effect.fail(new CassetteNotFoundError({ cassetteName: name })),
              onSome: Effect.succeed,
            }),
          ),
        ),
      append: (name, interaction, metadata) =>
        appendLock.withPermit(
          Effect.gen(function* () {
            const interactions = [...Option.getOrElse(HashMap.get(yield* Ref.get(stored), name), () => []), interaction]
            const findings = [
              ...Option.getOrElse(HashMap.get(yield* Ref.get(accumulatedFindings), name), () => []),
              ...secretFindings(interaction),
            ]
            const allFindings = metadata ? [...findings, ...secretFindings({ name, ...metadata })] : findings
            yield* failIfUnsafe(name, allFindings)
            yield* Ref.update(stored, (cassettes) => HashMap.set(cassettes, name, interactions))
            yield* Ref.update(accumulatedFindings, (entries) => HashMap.set(entries, name, findings))
          }),
        ),
      exists: (name) => Ref.get(stored).pipe(Effect.map((cassettes) => HashMap.has(cassettes, name))),
      list: () => Ref.get(stored).pipe(Effect.map((cassettes) => Array.from(HashMap.keys(cassettes)).toSorted())),
    })
  })
