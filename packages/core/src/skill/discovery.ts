export * as SkillDiscovery from "./discovery"

import path from "path"
import { NodeCrypto } from "@effect/platform-node"
import { Context, Crypto, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { AbsolutePath } from "../schema"

const skillConcurrency = 4
const fileConcurrency = 8

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

// decodeURIComponent throws a URIError for a malformed escape; such a segment is unsafe.
const decodeSegment = Option.liftThrowable(decodeURIComponent)

function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => Option.exists(decodeSegment(segment), isSafeSegment))
  )
}

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

interface SkillFile {
  readonly url: string
  readonly destination: string
  readonly file: string
}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const cryptoService = yield* Crypto.Crypto
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      if (yield* fs.exists(destination).pipe(Effect.orDie)) return true
      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(destination, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
      )
    })

    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        const base = url.endsWith("/") ? url : `${url}/`
        const source = new URL(base)
        const index = new URL("index.json", source).href
        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(Option.none())),
          ),
        )
        if (Option.isNone(data)) return []

        const sourceRoot = path.resolve(global.cache, "skills", Bun.hash(base).toString(16))
        return yield* Effect.forEach(
          data.value.skills.flatMap((skill) => {
            if (!isSafeSegment(skill.name)) {
              return []
            }
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              return []
            }

            const root = path.resolve(sourceRoot, skill.name)
            if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) {
              return []
            }

            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
            const versionFile = path.join(root, ".opencode-version")
            // One unsafe file rejects the whole skill.
            const files = Option.all(
              skill.files.map((file): Option.Option<SkillFile> => {
                if (!isSafeRelativePath(file) || !URL.canParse(file, skillUrl.href)) return Option.none()
                const resource = new URL(file, skillUrl)
                if (resource.origin !== source.origin) return Option.none()

                const destination = path.resolve(root, file)
                if (!FSUtil.contains(root, destination) || destination === root) return Option.none()
                return Option.some({
                  url: resource.href,
                  destination,
                  file,
                })
              }),
            )
            if (Option.isNone(files)) {
              return []
            }
            return [{ skill, root, versionFile, files: files.value }]
          }),
          ({ skill, root, versionFile, files }) =>
            Effect.gen(function* () {
              // Some(version) when the index names a version that the cached copy does not have.
              const pending = yield* Option.match(Option.fromUndefinedOr(skill.version), {
                onNone: () => Effect.succeed(Option.none<string>()),
                onSome: (version) =>
                  fs.readFileStringSafe(versionFile).pipe(
                    Effect.map((current) => (current === version ? Option.none<string>() : Option.some(version))),
                    Effect.catch(() => Effect.succeed(Option.some(version))),
                  ),
              })
              if (Option.isNone(pending)) {
                yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  concurrency: fileConcurrency,
                  discard: true,
                })
              } else {
                const version = pending.value
                const token = yield* cryptoService.randomUUIDv4.pipe(Effect.orDie)
                const staging = `${root}.tmp-${token}`
                const backup = `${root}.old-${token}`
                yield* Effect.gen(function* () {
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, path.resolve(staging, file.file)),
                    { concurrency: fileConcurrency },
                  )
                  if (!downloaded.every(Boolean)) return
                  const exists =
                    (yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie)) ||
                    (yield* fs.exists(path.join(staging, `${skill.name}.md`)).pipe(Effect.orDie))
                  if (!exists) return
                  yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
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
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              return exists ? [AbsolutePath.make(root)] : []
            }),
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
      }),
    })
  }),
).pipe(Layer.provide(NodeCrypto.layer))

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
