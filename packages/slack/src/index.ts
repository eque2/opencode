import { App, type AllMiddlewareArgs, type SlackCommandMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt"
import { createOpencode, type Event, type ToolPart } from "@opencode-ai/sdk"
import { Effect, Schema, Stream } from "effect"

class SlackBotError extends Schema.TaggedError<SlackBotError>()("SlackBotError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

// Bolt and the SDK expose Promise APIs. A rejection becomes a typed SlackBotError.
const attempt = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new SlackBotError({ operation, cause }) })

// A startup failure or a broken event stream used to crash the process with exit code 1.
const exitOnFailure = <A, E>(self: Effect.Effect<A, E>) =>
  self.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Slack bot failed", cause).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
    ),
  )

const main = Effect.gen(function* () {
  const app = yield* Effect.try({
    try: () =>
      new App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
      }),
    catch: (cause) => new SlackBotError({ operation: "new App", cause }),
  })

  console.log("🔧 Bot configuration:")
  console.log("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
  console.log("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
  console.log("- App token present:", !!process.env.SLACK_APP_TOKEN)

  console.log("🚀 Starting opencode server...")
  const opencode = yield* attempt("createOpencode", () =>
    createOpencode({
      port: 0,
    }),
  )
  console.log("✅ Opencode server ready")

  const sessions = new Map<string, { client: any; server: any; sessionId: string; channel: string; thread: string }>()

  const handleToolUpdate = Effect.fn("Slack.handleToolUpdate")(function* (
    part: ToolPart,
    channel: string,
    thread: string,
  ) {
    if (part.state.status !== "completed") return
    const toolMessage = `*${part.tool}* - ${part.state.title}`
    yield* attempt("chat.postMessage", () =>
      app.client.chat.postMessage({
        channel,
        thread_ts: thread,
        text: toolMessage,
      }),
    ).pipe(Effect.ignore)
  })

  const handleEvent = Effect.fn("Slack.handleEvent")(function* (event: Event) {
    if (event.type !== "message.part.updated") return
    const part = event.properties.part
    if (part.type !== "tool") return
    // Find the session for this tool update
    for (const [_sessionKey, session] of sessions.entries()) {
      if (session.sessionId === part.sessionID) {
        // Tool updates post in the background so that the event stream does not wait on Slack.
        yield* Effect.forkDetach(handleToolUpdate(part, session.channel, session.thread))
        break
      }
    }
  })

  // The event loop runs detached and outlives main.
  yield* attempt("event.subscribe", () => opencode.client.event.subscribe()).pipe(
    Effect.flatMap((events) =>
      Stream.fromAsyncIterable(events.stream, (cause) => new SlackBotError({ operation: "event.stream", cause })).pipe(
        Stream.runForEach(handleEvent),
      ),
    ),
    exitOnFailure,
    Effect.forkDetach,
  )

  const logRawEvent = Effect.fn("Slack.logRawEvent")(function* ({ next, context }: AllMiddlewareArgs) {
    console.log("📡 Raw Slack event:", JSON.stringify(context, null, 2))
    yield* Effect.promise(() => next())
  })

  const handleMessage = Effect.fn("Slack.handleMessage")(function* ({
    message,
    say,
  }: SlackEventMiddlewareArgs<"message">) {
    console.log("📨 Received message event:", JSON.stringify(message, null, 2))

    if (message.subtype || !("text" in message) || !message.text) {
      console.log("⏭️ Skipping message - no text or has subtype")
      return
    }

    console.log("✅ Processing message:", message.text)

    const channel = message.channel
    const thread = message.thread_ts || message.ts
    const sessionKey = `${channel}-${thread}`

    let session = sessions.get(sessionKey)

    if (!session) {
      console.log("🆕 Creating new opencode session...")
      const { client, server } = opencode

      const createResult = yield* attempt("session.create", () =>
        client.session.create({
          body: { title: `Slack thread ${thread}` },
        }),
      )

      if (createResult.error) {
        console.error("❌ Failed to create session:", createResult.error)
        yield* attempt("say", () =>
          say({
            text: "Sorry, I had trouble creating a session. Please try again.",
            thread_ts: thread,
          }),
        )
        return
      }

      console.log("✅ Created opencode session:", createResult.data.id)

      session = { client, server, sessionId: createResult.data.id, channel, thread }
      sessions.set(sessionKey, session)

      const shareResult = yield* attempt("session.share", () =>
        client.session.share({ path: { id: createResult.data.id } }),
      )
      if (!shareResult.error && shareResult.data) {
        const sessionUrl = shareResult.data.share?.url
        console.log("🔗 Session shared:", sessionUrl)
        yield* attempt("chat.postMessage", () =>
          app.client.chat.postMessage({ channel, thread_ts: thread, text: sessionUrl }),
        )
      }
    }

    console.log("📝 Sending to opencode:", message.text)
    // session.client is untyped, so the prompt result stays untyped as before.
    const result = yield* attempt<any>("session.prompt", () =>
      session.client.session.prompt({
        path: { id: session.sessionId },
        body: { parts: [{ type: "text", text: message.text }] },
      }),
    )

    console.log("📤 Opencode response:", JSON.stringify(result, null, 2))

    if (result.error) {
      console.error("❌ Failed to send message:", result.error)
      yield* attempt("say", () =>
        say({
          text: "Sorry, I had trouble processing your message. Please try again.",
          thread_ts: thread,
        }),
      )
      return
    }

    const response = result.data

    // Build response text
    const responseText =
      response.info?.content ||
      response.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n") ||
      "I received your message but didn't have a response."

    console.log("💬 Sending response:", responseText)

    // Send main response (tool updates will come via live events)
    yield* attempt("say", () => say({ text: responseText, thread_ts: thread }))
  })

  const handleTestCommand = Effect.fn("Slack.handleTestCommand")(function* ({
    command,
    ack,
    say,
  }: SlackCommandMiddlewareArgs) {
    yield* attempt("ack", () => ack())
    console.log("🧪 Test command received:", JSON.stringify(command, null, 2))
    yield* attempt("say", () => say("🤖 Bot is working! I can hear you loud and clear."))
  })

  // Bolt awaits the Promise that each listener returns.
  app.use((args) => Effect.runPromise(logRawEvent(args)))
  app.message((args) => Effect.runPromise(handleMessage(args)))
  app.command("/test", (args) => Effect.runPromise(handleTestCommand(args)))

  yield* attempt("app.start", () => app.start())
  console.log("⚡️ Slack bot is running!")
})

Effect.runFork(main.pipe(exitOnFailure))
