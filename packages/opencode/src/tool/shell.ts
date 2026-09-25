import { Array, Chunk, Effect, FileSystem, HashSet, Option, Schema, Scope, Stream } from "effect"
import os from "os"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

class ParseError extends Schema.TaggedError<ParseError>()("ShellTool.ParseError", {
  message: Schema.String,
}) {}

class InvalidTimeoutError extends Schema.TaggedError<InvalidTimeoutError>()("ShellTool.InvalidTimeoutError", {
  timeout: Schema.Number,
}) {
  override get message() {
    return `Invalid timeout value: ${this.timeout}. Timeout must be a positive number.`
  }
}

const MAX_METADATA_LENGTH = 30_000
const CWD: HashSet.HashSet<string> = HashSet.make("cd", "chdir", "popd", "pushd", "push-location", "set-location")
const FILES: HashSet.HashSet<string> = HashSet.union(
  CWD,
  HashSet.make(
    "rm",
    "cp",
    "mv",
    "mkdir",
    "touch",
    "chmod",
    "chown",
    "cat",
    // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
    // already hit the entries above, and alias normalization should happen in one
    // place later so we do not risk double-prompting.
    "get-content",
    "set-content",
    "add-content",
    "copy-item",
    "move-item",
    "remove-item",
    "new-item",
    "rename-item",
  ),
)
const CMD_FILES: HashSet.HashSet<string> = HashSet.make(
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
)
const FLAGS: HashSet.HashSet<string> = HashSet.make("-destination", "-literalpath", "-path")
const SWITCHES: HashSet.HashSet<string> = HashSet.make(
  "-confirm",
  "-debug",
  "-force",
  "-nonewline",
  "-recurse",
  "-verbose",
  "-whatif",
)

type Part = {
  type: string
  text: string
}

// Each list keeps the first occurrence of a value, in the order the scan found it.
type Scan = {
  dirs: ReadonlyArray<string>
  patterns: ReadonlyArray<string>
  always: ReadonlyArray<string>
}

// A decoded piece of the command output and its size in UTF-8 bytes.
type OutputPiece = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

// The value of an automatic PowerShell variable, or "" for a variable the scan does not know.
function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
  return ""
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell))
  return home(out)
}

// The filesystem path of a PowerShell provider path, or None for another provider.
function provider(text: string): Option.Option<string> {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) return match[1].toLowerCase() === "filesystem" ? Option.some(match[2]) : Option.none()
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix || prefix[1].length === 1) return Option.some(text)
  return Option.none()
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

// The literal part of a glob path, or None when the path starts with a glob character.
function prefix(text: string): Option.Option<string> {
  const match = /[?*[]/.exec(text)
  if (!match) return Option.some(text)
  if (match.index === 0) return Option.none()
  return Option.some(text.slice(0, match.index))
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (HashSet.has(SWITCHES, flag)) continue
      want = HashSet.has(FLAGS, flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const loaded = yield* Effect.promise(() => parsers())
  const tree = (ps ? loaded.ps : loaded.bash).parse(command)
  if (!tree) return yield* Effect.die(new ParseError({ message: "Failed to parse command" }))
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  fs: FSUtil.Interface,
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string },
) {
  if (scan.dirs.length > 0) {
    const globs = yield* Effect.forEach(scan.dirs, (dir) => {
      if (process.platform === "win32") return fs.normalizePathPattern(path.join(dir, "*"))
      return Effect.succeed(path.join(dir, "*"))
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories: scan.dirs,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.length === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: scan.patterns,
    always: scan.always,
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const loadParsers = Effect.gen(function* () {
  const { Parser } = yield* Effect.promise(() => import("web-tree-sitter"))
  const { default: treeWasm } = yield* Effect.promise(
    () =>
      import("web-tree-sitter/tree-sitter.wasm" as string, {
        with: { type: "wasm" },
      }),
  )
  const treePath = resolveWasm(treeWasm)
  yield* Effect.promise(() =>
    Parser.init({
      locateFile() {
        return treePath
      },
    }),
  )
  const { default: bashWasm } = yield* Effect.promise(
    () =>
      import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
        with: { type: "wasm" },
      }),
  )
  const { default: psWasm } = yield* Effect.promise(
    () =>
      import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
        with: { type: "wasm" },
      }),
  )
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = yield* Effect.all(
    [Effect.promise(() => Language.load(bashPath)), Effect.promise(() => Language.load(psPath))],
    { concurrency: "unbounded" },
  )
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// web-tree-sitter keeps one module per process, and Parser.init replaces it, so the parsers load
// once per process and every shell tool shares them.
const parsers = lazy(() => Effect.runPromise(loadParsers))

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return Option.none<string>()
      return Option.some(yield* fs.normalizePath(file))
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (Option.isSome(file)) return file.value
        }
        return yield* fs.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = prefix(text).pipe(Option.filter((file) => file.length > 0 && !dynamic(file, ps)))
      const next = ps ? Option.flatMap(file, provider) : file
      if (Option.isNone(next) || !next.value) return Option.none<string>()
      return Option.some(yield* resolvePath(next.value, cwd, shell))
    })

    // The folder of a path argument outside the instance, or None.
    const argDir = Effect.fnUntraced(function* (
      arg: string,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const found = yield* argPath(arg, cwd, ps, shell)
      const resolved = Option.getOrUndefined(found)
      yield* Effect.logInfo("resolved path", { arg, resolved })
      if (Option.isNone(found) || containsPath(found.value, instance)) return Option.none<string>()
      return Option.some((yield* fs.isDir(found.value)) ? found.value : path.dirname(found.value))
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const shellKind = ShellID.toKind(Shell.name(shell))

      const found = yield* Effect.forEach(commands(root), (node) =>
        Effect.gen(function* () {
          const command = parts(node)
          const tokens = command.map((item) => item.text)
          const cmd = (ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]) ?? ""
          const files = cmd && (HashSet.has(FILES, cmd) || (shellKind === "cmd" && HashSet.has(CMD_FILES, cmd)))
          const dirs = files
            ? yield* Effect.forEach(pathArgs(command, ps, shellKind === "cmd"), (arg) =>
                argDir(arg, cwd, ps, shell, instance),
              )
            : []
          const asks = tokens.length > 0 && (!cmd || !HashSet.has(CWD, cmd))
          return {
            dirs: Array.getSomes(dirs),
            patterns: asks ? [source(node)] : [],
            always: asks ? [BashArity.prefix(tokens).join(" ") + " *"] : [],
          }
        }),
      )

      return {
        dirs: Array.dedupe(found.flatMap((item) => item.dirs)),
        patterns: Array.dedupe(found.flatMap((item) => item.patterns)),
        always: Array.dedupe(found.flatMap((item) => item.always)),
      } satisfies Scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      let list = Chunk.empty<OutputPiece>()
      let used = 0
      let file = ""
      let sink = Option.none<FileSystem.File>()
      let cut = false
      let expired = false
      let aborted = false

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          // The output file lives in a child scope that is registered before the reader fiber
          // is forked, so the scope interrupts the reader before it closes the file.
          const sinkScope = yield* Scope.fork(yield* Scope.Scope)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list = Chunk.append(list, { text: chunk, size })
              used += size
              while (used > keep && Chunk.size(list) > 1) {
                const item = Chunk.head(list)
                if (Option.isNone(item)) break
                list = Chunk.drop(list, 1)
                used -= item.value.size
                cut = true
              }

              last = preview(last + chunk)

              const publish = ctx.metadata({
                metadata: {
                  output: last,
                },
              })

              if (file) {
                if (Option.isNone(sink)) return publish
                return sink.value.writeAll(Buffer.from(chunk, "utf-8")).pipe(
                  Effect.catch((error) => Effect.logWarning("shell output file write failed", { file, error })),
                  Effect.andThen(publish),
                )
              }
              full += chunk
              if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                return trunc.write(full).pipe(
                  Effect.tap((next) =>
                    fs.open(next, { flag: "a" }).pipe(
                      Scope.provide(sinkScope),
                      Effect.map(Option.some),
                      Effect.catch((error) =>
                        Effect.logWarning("shell output file open failed", { file: next, error }).pipe(
                          Effect.as(Option.none<FileSystem.File>()),
                        ),
                      ),
                      Effect.map((opened) => {
                        file = next
                        cut = true
                        sink = opened
                        full = ""
                      }),
                    ),
                  ),
                  Effect.andThen(publish),
                )
              }
              return publish
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = Chunk.join(
        Chunk.map(list, (item) => item.text),
        "",
      )
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = yield* Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = yield* Effect.fromResult(
          ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs),
        ).pipe(Effect.orDie)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                return yield* Effect.die(new InvalidTimeoutError({ timeout: params.timeout }))
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  yield* ask(
                    fs,
                    ctx,
                    containsPath(cwd, instanceCtx) ? scan : { ...scan, dirs: Array.dedupe([...scan.dirs, cwd]) },
                    params,
                  )
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
