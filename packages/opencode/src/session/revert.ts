import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
}).annotate({ identifier: "SessionRevert.RevertInput" })
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      // The revert point is the first part that matches the input, or the first part of the input message.
      const located = all.flatMap((msg, msgIndex) =>
        msg.parts.map((part, partIndex) => ({ msg, msgIndex, part, partIndex })),
      )
      const hitIndex = located.findIndex(
        (item) => (item.msg.info.id === input.messageID && !input.partID) || item.part.id === input.partID,
      )
      if (hitIndex < 0) return session
      const hit = located[hitIndex]

      // Keep the part target only when earlier text or tool parts of that message remain.
      const partID = hit.msg.parts.slice(0, hit.partIndex).some((item) => ["text", "tool"].includes(item.type))
        ? Option.fromNullishOr(input.partID)
        : Option.none()
      const lastUser = all.slice(0, hit.msgIndex + 1).findLast((msg) => msg.info.role === "user")
      const rev: NonNullable<Session.Info["revert"]> = {
        messageID: Option.isNone(partID) && lastUser ? lastUser.info.id : hit.msg.info.id,
        ...Option.match(partID, { onNone: () => ({}), onSome: (id) => ({ partID: id }) }),
      }
      // Patches after the revert point are undone.
      const patches: Snapshot.Patch[] = located
        .slice(hitIndex + 1)
        .flatMap((item) => (item.part.type === "patch" ? [item.part] : []))

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const index = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = index < 0 ? [] : all.slice(index)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = index < 0 ? Option.none() : Option.some(msgs[index])
      const remove = index < 0 ? [] : msgs.slice(index + (session.revert.partID ? 1 : 0))
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && Option.isSome(target)) {
        const partID = session.revert.partID
        const idx = target.value.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.value.parts.slice(idx)
          target.value.parts = target.value.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.value.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
