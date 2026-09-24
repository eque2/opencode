import { $ } from "bun"
import semver from "semver"
import path from "path"
import { Config, DateTime, Effect, Option, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"

/** Reads an optional environment variable; an empty value counts as absent. */
const optionalEnv = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.filter(Str.isNonEmpty)))

/** Failure while resolving the release channel, version, or team for a release script. */
class ScriptError extends Schema.TaggedError<ScriptError>()("ScriptError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const RootPackage = Schema.Struct({
  packageManager: Schema.optional(Schema.String),
}).annotate({ identifier: "RootPackage" })

const RegistryRelease = Schema.Struct({
  version: Schema.String,
}).annotate({ identifier: "RegistryRelease" })

const ScriptInfo = Schema.Struct({
  channel: Schema.String,
  version: Schema.String,
  preview: Schema.Boolean,
  release: Schema.Boolean,
  team: Schema.Array(Schema.String),
}).annotate({ identifier: "ScriptInfo" })

/** Pretty JSON form of the resolved Script values, as printed at import time. */
const ScriptInfoJson = Schema.fromJsonString(ScriptInfo, { space: 2 })

const program = Effect.gen(function* () {
  const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
  const rootPkg = yield* Effect.tryPromise({
    try: () => Bun.file(rootPkgPath).json(),
    catch: (cause) => new ScriptError({ message: `Failed to read ${rootPkgPath}`, cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RootPackage)))
  const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

  if (!expectedBunVersion) {
    return yield* new ScriptError({ message: "packageManager field not found in root package.json" })
  }

  // relax version requirement
  const expectedBunVersionRange = `^${expectedBunVersion}`

  if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
    return yield* new ScriptError({
      message: `This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`,
    })
  }

  const env = {
    OPENCODE_CHANNEL: yield* optionalEnv("OPENCODE_CHANNEL"),
    OPENCODE_BUMP: yield* optionalEnv("OPENCODE_BUMP"),
    OPENCODE_VERSION: yield* optionalEnv("OPENCODE_VERSION"),
    OPENCODE_RELEASE: yield* optionalEnv("OPENCODE_RELEASE"),
  }

  const channel = yield* Effect.gen(function* () {
    if (Option.isSome(env.OPENCODE_CHANNEL)) return env.OPENCODE_CHANNEL.value
    if (Option.isSome(env.OPENCODE_BUMP)) return "latest"
    if (Option.exists(env.OPENCODE_VERSION, (value) => !value.startsWith("0.0.0-"))) return "latest"
    return yield* Effect.tryPromise({
      try: () => $`git branch --show-current`.text(),
      catch: (cause) => new ScriptError({ message: "Failed to run git branch --show-current", cause }),
    }).pipe(Effect.map((x) => x.trim()))
  })
  const preview = channel !== "latest"

  const version = yield* Effect.gen(function* () {
    if (Option.isSome(env.OPENCODE_VERSION)) return env.OPENCODE_VERSION.value
    if (preview) {
      const stamp = DateTime.formatIso(yield* DateTime.now)
        .slice(0, 16)
        .replace(/[-:T]/g, "")
      return `0.0.0-${channel}-${stamp}`
    }
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const latest = yield* http
      .get("https://registry.npmjs.org/opencode-ai/latest")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RegistryRelease)))
    const [major, minor, patch] = latest.version.split(".").map((x) => Number(x) || 0)
    const t = Option.map(env.OPENCODE_BUMP, (value) => value.toLowerCase())
    if (Option.contains(t, "major")) return `${major + 1}.0.0`
    if (Option.contains(t, "minor")) return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
  })

  const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
  const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
  const members = yield* Effect.tryPromise({
    try: () => Bun.file(teamPath).text(),
    catch: (cause) => new ScriptError({ message: `Failed to read ${teamPath}`, cause }),
  }).pipe(
    Effect.map((x) => x.split(/\r?\n/).map((x) => x.trim())),
    Effect.map((x) => x.filter((x) => x && !x.startsWith("#"))),
  )

  const resolved = {
    channel,
    version,
    preview,
    release: Option.isSome(env.OPENCODE_RELEASE),
    team: [...members, ...bot],
  }
  yield* Effect.logInfo("opencode script", yield* Schema.encodeEffect(ScriptInfoJson)(resolved))
  return resolved
})

// eslint-disable-next-line effect/no-async-await-use-effect -- ES module top-level await: consumers read Script getters synchronously at import, so module evaluation must wait for the async registry, file and git lookups
const info = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))

export const Script = {
  get channel() {
    return info.channel
  },
  get version() {
    return info.version
  },
  get preview() {
    return info.preview
  },
  get release(): boolean {
    return info.release
  },
  get team() {
    return info.team
  },
}
