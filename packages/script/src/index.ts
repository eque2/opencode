import { $ } from "bun"
import semver from "semver"
import path from "path"
import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"

const RootPackage = Schema.Struct({
  packageManager: Schema.optional(Schema.String),
}).annotate({ identifier: "RootPackage" })

const RegistryRelease = Schema.Struct({
  version: Schema.String,
}).annotate({ identifier: "RegistryRelease" })

const program = Effect.gen(function* () {
  const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
  const rootPkg = yield* Effect.tryPromise(() => Bun.file(rootPkgPath).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RootPackage)),
  )
  const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

  if (!expectedBunVersion) {
    throw new Error("packageManager field not found in root package.json")
  }

  // relax version requirement
  const expectedBunVersionRange = `^${expectedBunVersion}`

  if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
    throw new Error(
      `This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`,
    )
  }

  const env = {
    OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
    OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
    OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
    OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
  }

  const channel = yield* Effect.gen(function* () {
    if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
    if (env.OPENCODE_BUMP) return "latest"
    if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
    return yield* Effect.tryPromise(() => $`git branch --show-current`.text()).pipe(Effect.map((x) => x.trim()))
  })
  const preview = channel !== "latest"

  const version = yield* Effect.gen(function* () {
    if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
    if (preview) return `0.0.0-${channel}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const latest = yield* http
      .get("https://registry.npmjs.org/opencode-ai/latest")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RegistryRelease)))
    const [major, minor, patch] = latest.version.split(".").map((x) => Number(x) || 0)
    const t = env.OPENCODE_BUMP?.toLowerCase()
    if (t === "major") return `${major + 1}.0.0`
    if (t === "minor") return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
  })

  const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
  const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
  const members = yield* Effect.tryPromise(() => Bun.file(teamPath).text()).pipe(
    Effect.map((x) => x.split(/\r?\n/).map((x) => x.trim())),
    Effect.map((x) => x.filter((x) => x && !x.startsWith("#"))),
  )

  return {
    channel,
    version,
    preview,
    release: !!env.OPENCODE_RELEASE,
    team: [...members, ...bot],
  }
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
console.log(`opencode script`, JSON.stringify(Script, null, 2))
