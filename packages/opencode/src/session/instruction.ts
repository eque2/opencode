import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Array as Arr, Context, Effect, HashSet, Layer, MutableHashMap, MutableHashSet, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  return HashSet.fromIterable(
    messages.flatMap((msg) =>
      msg.parts.flatMap((part) => {
        if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") return []
        if (part.state.time.compacted) return []
        const loaded: unknown = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) return []
        return loaded.filter((item): item is string => typeof item === "string")
      }),
    ),
  )
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  /** The system instruction paths in attach order, without duplicates. */
  readonly systemPaths: () => Effect.Effect<ReadonlyArray<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: MutableHashMap.empty<MessageID, MutableHashSet.MutableHashSet<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!(yield* FlagConfig.OPENCODE_DISABLE_PROJECT_CONFIG.pipe(Effect.orDie))) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout("5 seconds"),
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeedNone),
      )
      if (Option.isNone(res)) return ""
      const body = yield* res.value.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      MutableHashMap.remove(s.claims, messageID)
    })

    // The first global file that exists wins.
    const globalPaths = Effect.fnUntraced(function* () {
      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) return [file]
      }
      return []
    })

    // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
    const projectPaths = Effect.fnUntraced(function* () {
      if (yield* FlagConfig.OPENCODE_DISABLE_PROJECT_CONFIG.pipe(Effect.orDie)) return []
      const ctx = yield* InstanceState.context
      for (const file of instructionFiles) {
        const matches = yield* fs.findUp(file, ctx.directory, ctx.worktree).pipe(Effect.catch(() => Effect.succeed([])))
        if (matches.length > 0) return matches
      }
      return []
    })

    const configPaths = Effect.fnUntraced(function* (instructions: ReadonlyArray<string>) {
      const matches = yield* Effect.forEach(
        instructions.filter((raw) => !raw.startsWith("https://") && !raw.startsWith("http://")),
        (raw) => {
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          return (
            path.isAbsolute(instruction)
              ? fs.scan(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
        },
      )
      return matches.flat()
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const found = [
        ...(yield* globalPaths()),
        ...(yield* projectPaths()),
        ...(yield* configPaths(config.instructions ?? [])),
      ]
      // Dedupe keeps the first position of each path, as insertion into a Set did.
      return Arr.dedupe(found.map((item) => path.resolve(item)))
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(paths, read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...paths.flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      // Walk upward from the file being read, below the instance root.
      const directories = Arr.unfold(path.dirname(target), (current) =>
        current.startsWith(root) && current !== root
          ? Option.some([current, path.dirname(current)] as const)
          : Option.none(),
      )

      // Attach nearby instruction files once per message. The walk runs in order, one directory at a time.
      const attached = yield* Effect.forEach(
        directories,
        Effect.fnUntraced(function* (current) {
          const found = yield* find(current)
          if (!found || found === target || sys.includes(found) || HashSet.has(already, found)) return Option.none()

          const claimed = Option.getOrElse(MutableHashMap.get(s.claims, messageID), () => {
            const created = MutableHashSet.empty<string>()
            MutableHashMap.set(s.claims, messageID, created)
            return created
          })
          if (MutableHashSet.has(claimed, found)) return Option.none()

          MutableHashSet.add(claimed, found)
          const content = yield* read(found)
          if (!content) return Option.none()
          return Option.some({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }),
      )

      return Arr.getSomes(attached)
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
