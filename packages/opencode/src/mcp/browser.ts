import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import open from "open"

export class OpenError extends Schema.TaggedError<OpenError>()("McpBrowserOpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly open: (url: string) => Effect.Effect<void, OpenError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpBrowser") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    open: Effect.fn("McpBrowser.open")(function* (url: string) {
      const subprocess = yield* Effect.tryPromise({
        try: () => open(url),
        catch: (cause) => new OpenError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
      })
      // A launcher that fails reports it quickly; treat a quiet first 500 ms as a successful launch.
      yield* Effect.callback<void, OpenError>((resume) => {
        const onError = (cause: Error) => resume(Effect.fail(new OpenError({ message: cause.message, cause })))
        const onExit = (code: number | null) => {
          if (code === 0 || typeof code !== "number") return
          resume(Effect.fail(new OpenError({ message: `Browser open failed with exit code ${code}` })))
        }
        // Keep the listeners attached: an "error" event without a listener would crash the process.
        subprocess.on("error", onError)
        subprocess.on("exit", onExit)
      }).pipe(Effect.timeoutOption("500 millis"), Effect.asVoid)
    }),
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as McpBrowser from "./browser"
