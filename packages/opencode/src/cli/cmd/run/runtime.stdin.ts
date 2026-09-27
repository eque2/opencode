// eslint-disable-next-line effect/no-fs-use-effect-fs -- (a) the node:tty ReadStream constructor takes a numeric fd, and only fs.openSync opens one synchronously; effect FileSystem.open is async and closes the fd with its scope while the stream owns it
import fs from "fs"
import * as tty from "node:tty"
import { Result, Schema } from "effect"

export const INTERACTIVE_INPUT_ERROR = "--mini requires a controlling terminal for input"

export class InteractiveInputError extends Schema.TaggedError<InteractiveInputError>()("InteractiveInputError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// The parts of an input stream that the terminal check and the cleanup use.
type TerminalInput = {
  readonly isTTY?: boolean
  destroy(): unknown
}

export type InteractiveStdin<S extends TerminalInput = NodeJS.ReadStream> = {
  stdin: S
  cleanup?: () => void
}

function openTerminalStdin(path: string): NodeJS.ReadStream {
  return new tty.ReadStream(fs.openSync(path, "r"))
}

// Uses `stdin` when it is a terminal. Otherwise it opens the controlling
// terminal with `open` and returns a cleanup that closes it again.
export function resolveTerminalInput<S extends TerminalInput>(
  stdin: S,
  open: (path: string) => S,
  platform: NodeJS.Platform,
): Result.Result<InteractiveStdin<S>, InteractiveInputError> {
  if (stdin.isTTY) {
    return Result.succeed({ stdin })
  }

  const file = platform === "win32" ? "CONIN$" : "/dev/tty"
  return Result.try({
    try: () => open(file),
    catch: (cause) => new InteractiveInputError({ message: INTERACTIVE_INPUT_ERROR, cause }),
  }).pipe(
    Result.map((stream) => ({
      stdin: stream,
      cleanup: () => {
        stream.destroy()
      },
    })),
  )
}

// The terminal input of this process.
export function interactiveStdin(): Result.Result<InteractiveStdin, InteractiveInputError> {
  return resolveTerminalInput<NodeJS.ReadStream>(process.stdin, openTerminalStdin, process.platform)
}

// Synchronous form for run.ts, which probes the terminal outside Effect. It
// throws InteractiveInputError, whose message is INTERACTIVE_INPUT_ERROR, when
// no controlling terminal is available.
export function resolveInteractiveStdin(): InteractiveStdin {
  return Result.getOrThrow(interactiveStdin())
}
