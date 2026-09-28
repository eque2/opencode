import { Effect, Option, Schema } from "effect"
import { Share } from "./src/core/share"
import { Storage } from "./src/core/storage"

const test = Effect.gen(function* () {
  const shareInfo = yield* Share.create({ sessionID: "test-debug-" + Date.now() })

  const batch1: Share.Data[] = [
    { type: "part", data: { id: "part1", sessionID: "session1", messageID: "msg1", type: "text", text: "Hello" } },
  ]

  const batch2: Share.Data[] = [
    {
      type: "part",
      data: { id: "part1", sessionID: "session1", messageID: "msg1", type: "text", text: "Hello Updated" },
    },
  ]

  yield* Share.sync({
    share: { id: shareInfo.id, secret: shareInfo.secret },
    data: batch1,
  })

  yield* Share.sync({
    share: { id: shareInfo.id, secret: shareInfo.secret },
    data: batch2,
  })

  const events = yield* Storage.list({ prefix: ["share_event", shareInfo.id] })
  console.log("Events (raw):", events)
  console.log("Events (reversed):", events.toReversed())

  for (const event of events.toReversed()) {
    const data = yield* Storage.read(Schema.Array(Share.Data), event)
    console.log("Event data (reversed order):", event, Option.getOrUndefined(data))
  }

  yield* Share.remove({ id: shareInfo.id, secret: shareInfo.secret })
})

void Effect.runPromise(test)
