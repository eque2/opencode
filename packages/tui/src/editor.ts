import type { CliRenderer } from "@opentui/core"
import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Clock, Config, Effect, FileSystem, Option, Schema } from "effect"
import type { EditorIntegration } from "./context/editor"
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

export function discoverEditorConnection(directory: string) {
  const root = path.join(os.homedir(), ".claude", "ide")
  const contains = (parent: string) => {
    const resolved = path.resolve(parent)
    const relative = path.relative(resolved, path.resolve(directory))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
  }
  try {
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const file = path.join(root, entry)
        const port = Number.parseInt(path.basename(file, ".lock"), 10)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (value.transport !== undefined && value.transport !== "ws") return []
          const folders = Array.isArray(value.workspaceFolders)
            ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
            : []
          const score = Math.max(0, ...folders.map(contains))
          if (!score) return []
          return [
            {
              url: `ws://127.0.0.1:${port}`,
              authToken: typeof value.authToken === "string" ? value.authToken : undefined,
              source: `lock:${port}`,
              score,
              mtime: statSync(file).mtimeMs,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.score - left.score || right.mtime - left.mtime)
      .map(({ url, authToken, source }) => ({ url, authToken, source }))[0]
  } catch {
    return undefined
  }
}

export const editorIntegration: EditorIntegration = {
  connection: discoverEditorConnection,
  selection: resolveActiveZedSelection,
}
