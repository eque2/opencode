import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/app-node-platform"
import { Array as Arr, Effect, Layer, Option, Path, Random, Schema, Context } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

const skillConcurrency = 4
const fileConcurrency = 8

// Sixteen hex digits that keep the staging and backup folders of concurrent refreshes apart.
// The token only has to be unique, not secret.
const hex32 = Random.nextIntBetween(0, 0xffffffff).pipe(Effect.map((n) => n.toString(16).padStart(8, "0")))
const stagingToken = Effect.all([hex32, hex32]).pipe(Effect.map((parts) => parts.join("")))

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => res.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((err) => Effect.logError("failed to download", { url: url, error: err }).pipe(Effect.as(false))),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href
      const host = base.slice(0, -1)

      yield* Effect.logInfo("fetching index", { url: index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.map(Option.some),
        Effect.catch((err) =>
          Effect.logError("failed to fetch index", { url: index, error: err }).pipe(Effect.as(Option.none<Index>())),
        ),
      )

      if (Option.isNone(data)) return []

      const missing = data.value.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Effect.logWarning("skill entry missing SKILL.md", { url: index, skill: skill.name }),
        { discard: true },
      )
      const list = data.value.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            const root = path.join(cache, skill.name)
            const versionFile = path.join(root, ".opencode-version")
            const version = Option.fromNullishOr(skill.version)
            const current = Option.isNone(version)
              ? Option.none<string>()
              : yield* fs.readFileStringSafe(versionFile).pipe(
                  Effect.map(Option.fromNullishOr),
                  Effect.catch(() => Effect.succeed(Option.none<string>())),
                )

            if (Option.isNone(version) || Option.contains(current, version.value)) {
              yield* Effect.forEach(
                skill.files,
                (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(root, file)),
                { concurrency: fileConcurrency, discard: true },
              )
            } else {
              const token = yield* stagingToken
              const staging = `${root}.tmp-${token}`
              const backup = `${root}.old-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  skill.files,
                  (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(staging, file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
                yield* fs.writeFileString(path.join(staging, ".opencode-version"), version.value)
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const cached = yield* fs.exists(root).pipe(Effect.orDie)
                    if (cached) yield* fs.rename(root, backup)
                    yield* fs.rename(staging, root).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                          return yield* Effect.fail(error)
                        }),
                      ),
                    )
                    if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                  }),
                )
              }).pipe(
                Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            return (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie))
              ? Option.some(root)
              : Option.none()
          }),
        { concurrency: skillConcurrency },
      )

      return Arr.getSomes(dirs)
    })

    return Service.of({ pull })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, path, httpClient] })

export * as Discovery from "./discovery"
