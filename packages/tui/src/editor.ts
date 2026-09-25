import type { CliRenderer } from "@opentui/core"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Array as Arr, Clock, Config, Effect, FileSystem, Option, Order, Predicate, Schema } from "effect"
import type { EditorConnection, EditorIntegration } from "./context/editor"
import { resolveActiveZedSelection } from "./editor-zed"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

const filesystem = LayerNode.compile(LayerNodePlatform.filesystem)

// An empty variable counts as not set, as the former `||` chain did.
const setVariable = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value: string) => value.length > 0)))

// VISUAL wins over EDITOR.
const EditorCommandEnv = Config.all([setVariable("VISUAL"), setVariable("EDITOR")]).pipe(
  Config.map(([visual, editor]) => Option.orElse(visual, () => editor)),
)

class EditorLaunchError extends Schema.TaggedError<EditorLaunchError>()("TuiEditor.LaunchError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class EditorExitError extends Schema.TaggedError<EditorExitError>()("TuiEditor.ExitError", {
  message: Schema.String,
}) {}

type OpenEditorInput = { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }

// A Claude Code IDE lock file. A transport other than "ws", or folders that are not an array, skip the lock.
const LockFileSchema = Schema.Struct({
  transport: Schema.optionalKey(Schema.Literal("ws")),
  workspaceFolders: Schema.optionalKey(Schema.Array(Schema.Json)),
  authToken: Schema.optionalKey(Schema.Json),
}).annotate({ identifier: "TuiEditor.LockFile" })

const decodeLockFile = Schema.decodeUnknownOption(Schema.fromJsonString(LockFileSchema))

type LockCandidate = { connection: EditorConnection; score: number; mtime: number }

// The highest containment score first, then the most recently modified lock.
const byScoreThenNewest = Order.combine(
  Order.flip(Order.mapInput(Order.Number, (candidate: LockCandidate) => candidate.score)),
  Order.flip(Order.mapInput(Order.Number, (candidate: LockCandidate) => candidate.mtime)),
)

export function normalizePromptContent(content: string) {
  if (content.endsWith("\r\n")) {
    const body = content.slice(0, -2)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  if (content.endsWith("\n")) {
    const body = content.slice(0, -1)
    return !body.includes("\n") && !body.includes("\r") ? body : content
  }

  return content
}

/**
 * Opens `input.value` in $VISUAL or $EDITOR and resolves the edited text. It resolves undefined when neither
 * variable is set or the edited file is empty. It rejects when the editor cannot start or exits with an error.
 */
export function openEditor(input: OpenEditorInput): Promise<string | undefined> {
  return Effect.runPromise(editInEditor(input).pipe(Effect.map(Option.getOrUndefined)))
}

const editInEditor = Effect.fn("TuiEditor.openEditor")(function* (input: OpenEditorInput) {
  const command = yield* readEnvSnapshot(EditorCommandEnv)
  if (Option.isNone(command)) return Option.none<string>()

  const fs = yield* FileSystem.FileSystem
  const file = path.join(os.tmpdir(), `${yield* Clock.currentTimeMillis}.md`)
  yield* fs.writeFileString(file, input.value)
  const cwdExists = input.cwd ? yield* fs.exists(input.cwd).pipe(Effect.orElseSucceed(() => false)) : false
  const cwd = input.cwd && cwdExists ? input.cwd : process.cwd()

  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      input.renderer.suspend()
      input.renderer.currentRenderBuffer.clear()
    }),
    () =>
      runEditor(command.value, file, cwd, input.stdin).pipe(
        Effect.andThen(fs.readFileString(file)),
        Effect.map(Option.liftPredicate((content: string) => content.length > 0)),
      ),
    () =>
      fs.remove(file, { force: true }).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            input.renderer.currentRenderBuffer.clear()
            input.renderer.resume()
            input.renderer.requestRender()
          }),
        ),
      ),
  )
}, Effect.provide(filesystem))

// Runs the editor command on the file and waits for the editor to exit. The first word of the command is the
// program, and the other words are its arguments.
function runEditor(command: string, file: string, cwd: string, stdin: EditorStdio | undefined) {
  return Effect.callback<void, EditorLaunchError | EditorExitError>((resume) => {
    const parts = command.split(" ")
    const child = spawn(parts[0], [...parts.slice(1), file], {
      cwd,
      stdio: [stdin ?? "inherit", "inherit", "inherit"],
      shell: process.platform === "win32",
    })
    child.on("error", (cause) => {
      resume(Effect.fail(new EditorLaunchError({ message: cause.message, cause })))
    })
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resume(Effect.void)
        return
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`
      resume(Effect.fail(new EditorExitError({ message: `Editor exited with ${reason}` })))
    })
  })
}

/**
 * Finds the editor that serves `directory` from the Claude Code IDE lock files (~/.claude/ide/<port>.lock).
 * The lock whose workspace folder contains the directory most closely wins, then the newest lock.
 */
export const discoverEditorConnection = Effect.fn("TuiEditor.discoverEditorConnection")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = path.join(os.homedir(), ".claude", "ide")
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): Array<string> => []))
  const candidates = yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".lock")),
    (entry) => readLockFile(fs, path.join(root, entry), directory),
  )
  return Arr.head(Arr.sort(Arr.getSomes(candidates), byScoreThenNewest)).pipe(
    Option.map((candidate) => candidate.connection),
  )
}, Effect.provide(filesystem))

// A lock file that cannot be read, parsed or stated, or whose folders do not contain the directory, is skipped.
function readLockFile(
  fs: FileSystem.FileSystem,
  file: string,
  directory: string,
): Effect.Effect<Option.Option<LockCandidate>> {
  const port = Number.parseInt(path.basename(file, ".lock"), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Effect.succeedNone
  return Effect.gen(function* () {
    const lock = decodeLockFile(yield* fs.readFileString(file))
    if (Option.isNone(lock)) return Option.none<LockCandidate>()
    const folders = (lock.value.workspaceFolders ?? []).filter(Predicate.isString)
    const score = Math.max(0, ...folders.map((folder) => containmentScore(folder, directory)))
    if (!score) return Option.none<LockCandidate>()
    const info = yield* fs.stat(file)
    const authToken = lock.value.authToken
    return Option.some({
      connection: {
        url: `ws://127.0.0.1:${port}`,
        ...(Predicate.isString(authToken) ? { authToken } : {}),
        source: `lock:${port}`,
      },
      score,
      mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
    })
  }).pipe(Effect.orElseSucceed(() => Option.none<LockCandidate>()))
}

// The length of the resolved folder when it contains the directory, and 0 when it does not.
function containmentScore(folder: string, directory: string) {
  const resolved = path.resolve(folder)
  const relative = path.relative(resolved, path.resolve(directory))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
}

export const editorIntegration: EditorIntegration = {
  connection: discoverEditorConnection,
  selection: resolveActiveZedSelection,
}
