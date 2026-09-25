import type { Event } from "@opencode-ai/sdk/v2"
import type { TuiAttentionSoundName, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Effect, MutableHashSet } from "effect"

const id = "internal:notifications"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

function notify(api: TuiPluginApi, sessionID: string | undefined, message: string, sound: TuiAttentionSoundName) {
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void api.attention.notify({
    title: session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

const tui: TuiPlugin = (api) =>
  Effect.runPromise(
    Effect.sync(() => {
      const active = MutableHashSet.empty<string>()
      const errored = MutableHashSet.empty<string>()
      const questions = MutableHashSet.empty<string>()
      const permissions = MutableHashSet.empty<string>()

      api.event.on("question.asked", (event) => {
        if (MutableHashSet.has(questions, event.properties.id)) return
        MutableHashSet.add(questions, event.properties.id)
        notify(api, event.properties.sessionID, "Question needs input", "question")
      })

      api.event.on("question.replied", (event) => {
        MutableHashSet.remove(questions, event.properties.requestID)
      })

      api.event.on("question.rejected", (event) => {
        MutableHashSet.remove(questions, event.properties.requestID)
      })

      api.event.on("permission.asked", (event) => {
        if (MutableHashSet.has(permissions, event.properties.id)) return
        MutableHashSet.add(permissions, event.properties.id)
        notify(api, event.properties.sessionID, "Permission needs input", "permission")
      })

      api.event.on("permission.replied", (event) => {
        MutableHashSet.remove(permissions, event.properties.requestID)
      })

      api.event.on("session.status", (event) => {
        const sessionID = event.properties.sessionID
        if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
          MutableHashSet.add(active, sessionID)
          MutableHashSet.remove(errored, sessionID)
          return
        }

        if (event.properties.status.type !== "idle") return
        if (!MutableHashSet.has(active, sessionID)) return
        MutableHashSet.remove(active, sessionID)

        if (MutableHashSet.has(errored, sessionID)) {
          MutableHashSet.remove(errored, sessionID)
          return
        }

        const session = api.state.session.get(sessionID)
        notify(api, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
      })

      api.event.on("session.error", (event) => {
        const sessionID = event.properties.sessionID
        if (!sessionID) return
        if (!MutableHashSet.has(active, sessionID)) return
        MutableHashSet.add(errored, sessionID)
        notify(api, sessionID, sessionErrorMessage(event.properties.error), "error")
      })
    }),
  )

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
