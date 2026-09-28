import { createSignal, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Effect, Schema, Semaphore } from "effect"
import { createSimpleContext } from "./helper"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { fileSystemLayer, readJson, writeJsonAtomic } from "../util/persistence"
import { useTuiPaths } from "./runtime"
import path from "path"

// The KV file is one JSON object. Its values come from the TUI and from plugins.
const KVState = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "TuiKV.State" })
const decodeKVFile = Schema.fromJsonString(KVState)
// Plugin values are untyped, so writes keep JSON.stringify semantics (an undefined key is dropped).
const encodeKVFile = Schema.fromJsonString(Schema.Unknown)

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const paths = useTuiPaths()
    void Global.Path.state
    const file = path.join(paths.state, "kv.json")
    const lock = `tui-kv:${file}`
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    // One same-process write at a time. Each write takes its snapshot when it holds the permit,
    // so the last write always persists the latest state, whatever order the waiters resume in.
    const writes = Semaphore.makeUnsafe(1)

    const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(Flock.effect(lock).pipe(Effect.andThen(effect)))

    Effect.runFork(
      withLock(readJson(file, decodeKVFile)).pipe(
        Effect.tap((value) => Effect.sync(() => setStore(value))),
        Effect.catchCause((cause) => Effect.logError("Failed to read KV state", cause)),
        Effect.ensuring(Effect.sync(() => setReady(true))),
        Effect.provide(fileSystemLayer),
      ),
    )

    const persist = Effect.sync(() => structuredClone(unwrap(store))).pipe(
      Effect.flatMap((snapshot) => withLock(writeJsonAtomic(file, encodeKVFile, snapshot))),
      writes.withPermits(1),
      Effect.catchCause((cause) => Effect.logError("Failed to write KV state", cause)),
      Effect.provide(fileSystemLayer),
    )

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        Effect.runFork(persist)
      },
    }
    return result
  },
})
