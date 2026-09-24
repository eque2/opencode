/// <reference path="./parcel-watcher-wrapper.d.ts" />
export * as Watcher from "./watcher"

import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { makeLocationNode } from "../effect/app-node"
import { Cause, Context, Effect, Layer, Option, Result } from "effect"
import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const OPENCODE_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = FileSystemWatcher.Event

// The native binding is optional: without one for this platform the watcher stays off.
const watcher = lazy((): Option.Option<typeof import("@parcel/watcher")> => {
  const libc = typeof OPENCODE_LIBC === "string" && OPENCODE_LIBC ? OPENCODE_LIBC : "glibc"
  return Result.getSuccess(
    Result.try(() =>
      createWrapper(
        require(`@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc}` : ""}`),
      ),
    ),
  )
})

function getBackend(): Option.Option<ParcelWatcher.BackendType> {
  if (process.platform === "win32") return Option.some("windows")
  if (process.platform === "darwin") return Option.some("fs-events")
  if (process.platform === "linux") return Option.some("inotify")
  return Option.none()
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => Option.isSome(watcher())

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const supported = getBackend()
    const location = yield* Location.Service
    if (Option.isNone(supported)) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }
    const backend = supported.value

    const binding = watcher()
    if (Option.isNone(binding)) return Service.of({})
    const w = binding.value

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    // Unsubscribe failures are ignored: the watcher is shutting down either way.
    const unsubscribe = (subscription: ParcelWatcher.AsyncSubscription) =>
      Effect.tryPromise(() => subscription.unsubscribe()).pipe(Effect.ignore)

    const callback: ParcelWatcher.SubscribeCallback = (_error, updates) => {
      for (const update of updates) {
        if (update.type === "create") runFork(events.publish(Event.Updated, { file: update.path, event: "add" }))
        if (update.type === "update") runFork(events.publish(Event.Updated, { file: update.path, event: "change" }))
        if (update.type === "delete") runFork(events.publish(Event.Updated, { file: update.path, event: "unlink" }))
      }
    }

    // Each subscription is released when the layer scope closes. A subscription that
    // resolves after the timeout is released in the background as soon as it arrives.
    const subscribe = (directory: string, ignore: string[]) => {
      const pending = w.subscribe(directory, callback, { ignore, backend })
      return Effect.promise(() => pending).pipe(
        Effect.tap((subscription) => Effect.addFinalizer(() => unsubscribe(subscription))),
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.catchCause((cause) =>
          Effect.tryPromise(() => pending).pipe(
            Effect.flatMap(unsubscribe),
            Effect.ignore,
            Effect.forkDetach,
            Effect.andThen(Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) })),
          ),
        ),
      )
    }

    const config = (yield* (yield* Config.Service).entries())
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    if (location.vcs && (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER)) {
      yield* Effect.forkScoped(
        subscribe(location.directory, [...Ignore.PATTERNS, ...config, ...protecteds(location.directory)]),
      )
    }

    const resolved = location.vcs?.type === "git" ? (yield* git.repo.discover(location.directory))?.gitDirectory : ""
    if (resolved) {
      const vcs = yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved)))
      if (!config.includes(".git") && !config.includes(vcs) && !config.includes(resolved)) {
        const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
          (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
        )
        yield* Effect.forkScoped(subscribe(vcs, ignore))
      }
    }

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, Git.node, EventV2.node],
})
