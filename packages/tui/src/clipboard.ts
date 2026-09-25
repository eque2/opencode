import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { lazy } from "@opencode-ai/core/util/lazy"
import { Config, Data, Effect, FileSystem, Option } from "effect"
import { execFile, spawn } from "node:child_process"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const filesystem = LayerNode.compile(LayerNodePlatform.filesystem)

class ClipboardCommandError extends Data.TaggedError("TuiClipboard.CommandError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// An empty variable counts as unset, as the former truthiness checks on process.env did.
const multiplexer = Config.all({
  tmux: Config.String("TMUX").pipe(Config.withDefault("")),
  screen: Config.String("STY").pipe(Config.withDefault("")),
})
const waylandDisplay = Config.String("WAYLAND_DISPLAY").pipe(Config.withDefault(""))

/**
 * Read an image or text from the system clipboard. Images come back as base64
 * PNG. The result is None when the clipboard holds neither.
 */
export const read = Effect.fn("TuiClipboard.read")(function* () {
  if (platform() === "darwin") {
    const image = yield* macosImage
    if (Option.isSome(image)) return Option.some({ data: Buffer.from(image.value).toString("base64"), mime: "image/png" })
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const image = yield* stdout("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script])
    if (Option.isSome(image)) return Option.some({ data: image.value.toString().trim(), mime: "image/png" })
  }

  if (platform() === "linux") {
    const wayland = yield* stdout("wl-paste", ["-t", "image/png"])
    if (Option.isSome(wayland)) return Option.some({ data: wayland.value.toString("base64"), mime: "image/png" })
    const x11 = yield* stdout("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"])
    if (Option.isSome(x11)) return Option.some({ data: x11.value.toString("base64"), mime: "image/png" })
  }

  const { default: clipboardy } = yield* Effect.promise(() => import("clipboardy"))
  const text = yield* Effect.option(Effect.tryPromise(() => clipboardy.read()))
  return Option.map(
    Option.filter(text, (value) => value.length > 0),
    (data) => ({ data, mime: "text/plain" }),
  )
}, Effect.provide(filesystem))

/**
 * Copy text to the system clipboard. An OSC 52 sequence goes to the terminal
 * first, then the native clipboard command, or clipboardy when none is
 * installed. A failed copy is ignored.
 */
export const write = Effect.fn("TuiClipboard.write")(function* (text: string) {
  yield* writeOsc52(text)
  const copy = yield* Effect.promise(copyMethod)
  yield* copy(text)
})

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
  return undefined
}

// Every command that copyCommand can ask about, so one lookup pass answers all of its checks.
const COPY_COMMANDS = ["osascript", "wl-copy", "xclip", "xsel", "powershell.exe"]

// The copy method is resolved once per process, on the first write.
const copyMethod = lazy(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { which } = yield* Effect.promise(() => import("@opencode-ai/core/util/which"))
      const installed = yield* Effect.filter(COPY_COMMANDS, (name) => which(name).pipe(Effect.map(Option.isSome)))
      const wayland = yield* readEnvSnapshot(waylandDisplay)
      const native = copyCommand(platform(), wayland !== "", (name) => installed.includes(name))
      if (native?.[0] === "osascript") {
        return (text: string) => {
          const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
          return Effect.ignore(command("osascript", ["-e", `set the clipboard to "${escaped}"`]))
        }
      }
      if (native) return (text: string) => Effect.ignore(command(native[0], native.slice(1), text))
      return (text: string) =>
        Effect.gen(function* () {
          const { default: clipboardy } = yield* Effect.promise(() => import("clipboardy"))
          yield* Effect.ignore(Effect.tryPromise(() => clipboardy.write(text)))
        })
    }),
  ),
)

// osascript writes the clipboard PNG to a temporary file. The file is removed
// afterwards whether or not the clipboard held an image.
const macosImage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const file = path.join(tmpdir(), "opencode-clipboard.png")
  return yield* Effect.tryPromise(() =>
    exec("osascript", [
      "-e",
      'set imageData to the clipboard as "PNGf"',
      "-e",
      `set fileRef to open for access POSIX file "${file}" with write permission`,
      "-e",
      "set eof fileRef to 0",
      "-e",
      "write imageData to fileRef",
      "-e",
      "close access fileRef",
    ]),
  ).pipe(
    Effect.andThen(fs.readFile(file)),
    Effect.option,
    Effect.ensuring(Effect.ignore(fs.remove(file, { force: true }))),
  )
})

const writeOsc52 = Effect.fnUntraced(function* (text: string) {
  if (!process.stdout.isTTY) return
  const env = yield* readEnvSnapshot(multiplexer)
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  const passthrough = `\x1bPtmux;\x1b${sequence}\x1b\\`
  process.stdout.write(env.tmux ? sequence + passthrough : env.screen ? passthrough : sequence)
})

// The command's stdout, or None when it fails or prints nothing.
const stdout = (name: string, args: ReadonlyArray<string>) =>
  command(name, args).pipe(
    Effect.option,
    Effect.map(Option.filter((bytes) => bytes.length > 0)),
  )

// Run a command and collect its stdout. It fails when the command does not
// start or exits with a code other than 0.
const command = (name: string, args: ReadonlyArray<string> = [], input?: string) =>
  Effect.try({
    try: () => spawn(name, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] }),
    catch: (cause) => new ClipboardCommandError({ message: `${name} did not start`, cause }),
  }).pipe(
    Effect.flatMap((child) =>
      Effect.callback<Buffer, ClipboardCommandError>((resume) => {
        const output: Buffer[] = []
        child.on("error", (cause) => resume(Effect.fail(new ClipboardCommandError({ message: `${name} failed`, cause }))))
        child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
        child.on("close", (code) =>
          resume(
            code === 0
              ? Effect.succeed(Buffer.concat(output))
              : Effect.fail(new ClipboardCommandError({ message: `${name} exited with code ${code}` })),
          ),
        )
        if (input !== undefined) child.stdin?.end(input)
      }),
    ),
  )
