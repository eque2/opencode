import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    yield* ACPProfile.mark("cli.acp.handler")
    // eslint-disable-next-line effect/no-process-env-use-config -- (a) env write, not a read: the in-process server reads OPENCODE_CLIENT from process.env through its ConfigProvider, and Effect Config cannot write env
    process.env.OPENCODE_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts)).pipe(ACPProfile.measure("cli.acp.server.listen"))

    const sdk = createOpencodeClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: yield* ServerAuth.headers(),
    })

    const input = new WritableStream<Uint8Array>({
      // The stream sink awaits each write, so the write Effect runs to a Promise here.
      write(chunk) {
        return Effect.runPromise(
          Effect.callback<void, Error>((resume) => {
            process.stdout.write(chunk, (err) => resume(err ? Effect.fail(err) : Effect.void))
          }),
        )
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })
    // The connection factory is a synchronous SDK callback, so the mark runs on this handler's context.
    const runFork = Effect.runForkWith(yield* Effect.context())

    new AgentSideConnection((conn) => {
      runFork(ACPProfile.mark("cli.acp.connection.create"))
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    // A stdin error stays a defect, as it was when this wait was a rejected Promise.
    yield* Effect.callback<void>((resume) => {
      process.stdin.on("end", () => resume(Effect.void))
      process.stdin.on("error", (err) => resume(Effect.die(err)))
    })
  }),
})
