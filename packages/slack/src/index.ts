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

// Debug payloads are logged as JSON with two-space indentation.
const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

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

  yield* Effect.logInfo("🔧 Bot configuration:")
  yield* Effect.logInfo("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
  yield* Effect.logInfo("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
  yield* Effect.logInfo("- App token present:", !!process.env.SLACK_APP_TOKEN)

  yield* Effect.logInfo("🚀 Starting opencode server...")
  const opencode = yield* attempt("createOpencode", () =>
    createOpencode({
      port: 0,
    }),
  )
  yield* Effect.logInfo("✅ Opencode server ready")

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
    yield* Effect.logInfo("📡 Raw Slack event:", yield* encodePrettyJson(context))
    yield* Effect.promise(() => next())
  })

  const handleMessage = Effect.fn("Slack.handleMessage")(function* ({
    message,
    say,
  }: SlackEventMiddlewareArgs<"message">) {
    yield* Effect.logInfo("📨 Received message event:", yield* encodePrettyJson(message))

    if (message.subtype || !("text" in message) || !message.text) {
      yield* Effect.logInfo("⏭️ Skipping message - no text or has subtype")
      return
    }

    yield* Effect.logInfo("✅ Processing message:", message.text)

    const channel = message.channel
    const thread = message.thread_ts || message.ts
    const sessionKey = `${channel}-${thread}`

    let session = sessions.get(sessionKey)

    if (!session) {
      yield* Effect.logInfo("🆕 Creating new opencode session...")
      const { client, server } = opencode

      const createResult = yield* attempt("session.create", () =>
        client.session.create({
          body: { title: `Slack thread ${thread}` },
        }),
      )

      if (createResult.error) {
        yield* Effect.logError("❌ Failed to create session:", createResult.error)
        yield* attempt("say", () =>
          say({
            text: "Sorry, I had trouble creating a session. Please try again.",
            thread_ts: thread,
          }),
        )
        return
      }

      yield* Effect.logInfo("✅ Created opencode session:", createResult.data.id)

      session = { client, server, sessionId: createResult.data.id, channel, thread }
      sessions.set(sessionKey, session)

      const shareResult = yield* attempt("session.share", () =>
        client.session.share({ path: { id: createResult.data.id } }),
      )
      if (!shareResult.error && shareResult.data) {
        const sessionUrl = shareResult.data.share?.url
        yield* Effect.logInfo("🔗 Session shared:", sessionUrl)
        yield* attempt("chat.postMessage", () =>
          app.client.chat.postMessage({ channel, thread_ts: thread, text: sessionUrl }),
        )
      }
    }

    yield* Effect.logInfo("📝 Sending to opencode:", message.text)
    // session.client is untyped, so the prompt result stays untyped as before.
    const result = yield* attempt<any>("session.prompt", () =>
      session.client.session.prompt({
        path: { id: session.sessionId },
        body: { parts: [{ type: "text", text: message.text }] },
      }),
    )

    yield* Effect.logInfo("📤 Opencode response:", yield* encodePrettyJson(result))

    if (result.error) {
      yield* Effect.logError("❌ Failed to send message:", result.error)
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

    yield* Effect.logInfo("💬 Sending response:", responseText)

    // Send main response (tool updates will come via live events)
    yield* attempt("say", () => say({ text: responseText, thread_ts: thread }))
  })

  const handleTestCommand = Effect.fn("Slack.handleTestCommand")(function* ({
    command,
    ack,
    say,
  }: SlackCommandMiddlewareArgs) {
    yield* attempt("ack", () => ack())
    yield* Effect.logInfo("🧪 Test command received:", yield* encodePrettyJson(command))
    yield* attempt("say", () => say("🤖 Bot is working! I can hear you loud and clear."))
  })

  // Bolt awaits the Promise that each listener returns.
  app.use((args) => Effect.runPromise(logRawEvent(args)))
  app.message((args) => Effect.runPromise(handleMessage(args)))
  app.command("/test", (args) => Effect.runPromise(handleTestCommand(args)))

  yield* attempt("app.start", () => app.start())
  yield* Effect.logInfo("⚡️ Slack bot is running!")
})

Effect.runFork(main.pipe(exitOnFailure))
