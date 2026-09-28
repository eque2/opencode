export * as SessionRevert from "./revert"

import { and, asc, eq, gt } from "drizzle-orm"
import { DateTime, Effect, HashMap, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

const plan = Effect.fn("SessionRevert.plan")(function* (input: BoundaryInput) {
  const db = (yield* Database.Service).db
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const messages = yield* Effect.forEach(rows, (row) =>
    decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
  )
  const touched = messages.flatMap((message) => {
    if (message.type !== "assistant" || !message.snapshot?.start) return []
    const tree = Snapshot.ID.make(message.snapshot.start)
    return (message.snapshot.files ?? []).map((file): readonly [RelativePath, Snapshot.ID] => [file, tree])
  })
  // The earliest step after the boundary holds the tree to restore for each file. The order of the
  // first occurrences is the order of the staged diff.
  return touched.filter(([file], index) => touched.findIndex(([first]) => first === file) === index)
})

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
}) {
  const snapshot = yield* Snapshot.Service
  const events = yield* EventV2.Service
  const original = input.session.revert?.snapshot
    ? Snapshot.ID.make(input.session.revert.snapshot)
    : yield* snapshot.capture()
  const next = yield* plan({ sessionID: input.session.id, messageID: input.messageID })
  const previous = original
    ? (input.session.revert?.files ?? []).map((file): readonly [RelativePath, Snapshot.ID] => [file.path, original])
    : []
  // Files of the new revert point take precedence over files of the previously staged revert.
  const restore = HashMap.fromIterable([...previous, ...(input.files === false ? [] : next)])
  if (HashMap.size(restore) > 0) yield* snapshot.restore({ files: restore })
  const paths = input.files === false ? [] : next.map(([file]) => file)
  const files = original
    ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
    : []
  const revert = {
    messageID: input.messageID,
    snapshot: original,
    diff: files
      .map((file) => file.patch)
      .join("")
      .trim(),
    files,
  } satisfies SessionSchema.Info["revert"]
  yield* events.publish(SessionEvent.RevertEvent.Staged, {
    sessionID: input.session.id,
    timestamp: yield* DateTime.now,
    revert,
  })
  return revert
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const snapshot = yield* Snapshot.Service
  if (session.revert.snapshot) {
    const original = Snapshot.ID.make(session.revert.snapshot)
    yield* snapshot.restore({
      files: HashMap.fromIterable((session.revert.files ?? []).map((file) => [file.path, original] as const)),
    })
  }
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Cleared, {
    sessionID: session.id,
    timestamp: yield* DateTime.now,
  })
})

export const commit = Effect.fn("SessionRevert.commit")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    messageID: session.revert.messageID,
    timestamp: yield* DateTime.now,
  })
})
