import path from "path"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { NodeFileSystem } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Option } from "effect"
import { Flock } from "./util/flock"
import { FlagConfig } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

const app = "opencode"
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

const ensureDirectories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.forEach(
    [Path.data, Path.config, Path.state, Path.tmp, Path.log, Path.bin, Path.repos],
    (dir) => fs.makeDirectory(dir, { recursive: true }),
    { concurrency: "unbounded", discard: true },
  )
})

// eslint-disable-next-line effect/no-async-await-use-effect -- ES module top-level await: importers use the Global.Path directories synchronously at import (logs, bin, state), so module evaluation must wait until they exist
await Effect.runPromise(ensureDirectories.pipe(Effect.provide(NodeFileSystem.layer)))

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

/** The default directories with the input on top. It reads no environment variable. */
export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

/**
 * The directories with the environment overrides, then the input, on top. The CLI and tests set
 * OPENCODE_CONFIG_DIR after start, so each build reads the live value. The variable is optional,
 * so a ConfigError is a defect.
 */
const fromEnvironment = (input: Partial<Interface>) =>
  Effect.gen(function* () {
    const config = Option.getOrElse(yield* FlagConfig.OPENCODE_CONFIG_DIR, () => Path.config)
    return Service.of(make({ config, ...input }))
  }).pipe(Effect.orDie)

const layer = Layer.effect(Service, fromEnvironment({}))

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, fromEnvironment(input))

export * as Global from "./global"
