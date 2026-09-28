import type {
  AgentV2Info,
  CommandV2Info,
  IntegrationInfo,
  LocationRef,
  ModelV2Info,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderV2Info,
  QuestionV2Request,
  ReferenceInfo,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageShell,
  SessionV2Info,
  SkillV2Info,
  Event,
} from "@opencode-ai/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { Data, Effect, Schema } from "effect"
import { errorMessage } from "../util/error"

type LocationData = {
  agent?: AgentV2Info[]
  command?: CommandV2Info[]
  integration?: IntegrationInfo[]
  model?: ModelV2Info[]
  provider?: ProviderV2Info[]
  reference?: ReferenceInfo[]
  skill?: SkillV2Info[]
}

type DataStore = {
  session: {
    info: Record<string, SessionV2Info>
    message: Record<string, SessionMessage[]>
    permission: Record<string, PermissionV2Request[]>
    question: Record<string, QuestionV2Request[]>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

// Store key for a location: the JSON text of [directory, workspaceID].
const LocationKey = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String)])).annotate({
  identifier: "TuiData.LocationKey",
})
const encodeLocationKey = Schema.encodeSync(LocationKey)

function locationKey(location: LocationRef) {
  return encodeLocationKey([location.directory, location.workspaceID])
}

/** A failed data request. `message` is the text that Promise consumers see. */
class DataRequestError extends Data.TaggedError("TuiData.RequestError")<{
  readonly message: string
  readonly cause: unknown
}> {}

function request<A>(evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new DataRequestError({ message: errorMessage(cause), cause }),
  })
}

// Request parameters for a location read; no ref means the server default.
function locationQuery(ref?: LocationRef) {
  return ref ? { location: { directory: ref.directory, workspace: ref.workspaceID } } : {}
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<DataStore>({
      session: {
        info: {},
        message: {},
        permission: {},
        question: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })

    const sdk = useSDK()
    const events = useEvent()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })

    const message = {
      update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []))
          }),
        )
      },
      prepend(sessionID: string, item: SessionMessage) {
        setStore("session", "message", sessionID, (messages = []) =>
          messages.some((existing) => existing.id === item.id) ? messages : [item, ...messages],
        )
      },
      activeAssistant(messages: SessionMessage[]) {
        return messages.find(
          (item): item is SessionMessageAssistant => item.type === "assistant" && !item.time.completed,
        )
      },
      assistant(messages: SessionMessage[], messageID: string) {
        return messages.find(
          (item): item is SessionMessageAssistant => item.type === "assistant" && item.id === messageID,
        )
      },
      activeShell(messages: SessionMessage[], callID: string) {
        return messages.find((item): item is SessionMessageShell => item.type === "shell" && item.callID === callID)
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
        )
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
        )
      },
    }

    const load = {
      session: (sessionID: string) =>
        request(() => sdk.client.v2.session.get({ sessionID }, { throwOnError: true })).pipe(
          Effect.map((response) => setStore("session", "info", sessionID, response.data.data)),
        ),
      sessionMessages: (sessionID: string) =>
        request(() => sdk.client.v2.session.messages({ sessionID }, { throwOnError: true })).pipe(
          Effect.map((response) => setStore("session", "message", sessionID, response.data.data)),
        ),
      sessionPermissions: (sessionID: string) =>
        request(() => sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })).pipe(
          Effect.map((response) => setStore("session", "permission", sessionID, response.data.data)),
        ),
      sessionQuestions: (sessionID: string) =>
        request(() => sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true })).pipe(
          Effect.map((response) => setStore("session", "question", sessionID, response.data.data)),
        ),
      projectPermissions: (projectID: string) =>
        request(() => sdk.client.v2.permission.saved.list({ projectID }, { throwOnError: true })).pipe(
          Effect.map((response) => setStore("project", "permission", projectID, response.data.data)),
        ),
      location: (ref?: LocationRef) =>
        request(() => sdk.client.v2.location.get(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) => {
            const location = response.data
            const key = locationKey(location)
            if (!store.location[key]) setStore("location", key, {})
            if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
          }),
        ),
      agent: (ref?: LocationRef) =>
        request(() => sdk.client.v2.agent.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "agent", response.data.data),
          ),
        ),
      command: (ref?: LocationRef) =>
        request(() => sdk.client.v2.command.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "command", response.data.data),
          ),
        ),
      integration: (ref?: LocationRef) =>
        request(() => sdk.client.v2.integration.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "integration", response.data.data),
          ),
        ),
      model: (ref?: LocationRef) =>
        request(() => sdk.client.v2.model.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "model", response.data.data),
          ),
        ),
      provider: (ref?: LocationRef) =>
        request(() => sdk.client.v2.provider.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "provider", response.data.data),
          ),
        ),
      reference: (ref?: LocationRef) =>
        request(() => sdk.client.v2.reference.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "reference", response.data.data),
          ),
        ),
      skill: (ref?: LocationRef) =>
        request(() => sdk.client.v2.skill.list(locationQuery(ref), { throwOnError: true })).pipe(
          Effect.map((response) =>
            setStore("location", locationKey(response.data.location), "skill", response.data.data),
          ),
        ),
    }

    // Runs refreshes side by side; each failure is logged and does not stop the others.
    function refreshAll(message: string, tasks: ReadonlyArray<Effect.Effect<void, DataRequestError>>) {
      Effect.runFork(
        Effect.forEach(tasks, (task) => task.pipe(Effect.catch((error) => Effect.logError(message, error.cause))), {
          concurrency: "unbounded",
          discard: true,
        }),
      )
    }

    function handleEvent(event: Event, location: LocationRef) {
      switch (event.type) {
        case "catalog.updated":
          refreshAll("Failed to refresh location data", [load.model(location), load.provider(location)])
          break
        case "session.next.agent.switched":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "agent-switched",
            agent: event.properties.agent,
            time: { created: event.properties.timestamp },
          })
          break
        case "session.next.model.switched":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "model-switched",
            model: event.properties.model,
            time: { created: event.properties.timestamp },
          })
          break
        case "session.next.prompted": {
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "user",
            text: event.properties.prompt.text,
            files: event.properties.prompt.files,
            agents: event.properties.prompt.agents,
            time: { created: event.properties.timestamp },
          })
          break
        }
        case "session.next.prompt.admitted":
          break
        case "session.next.context.updated":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "system",
            text: event.properties.text,
            time: { created: event.properties.timestamp },
          })
          break
        case "session.next.synthetic":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "synthetic",
            sessionID: event.properties.sessionID,
            text: event.properties.text,
            time: { created: event.properties.timestamp },
          })
          break
        case "session.next.shell.started":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "shell",
            callID: event.properties.callID,
            command: event.properties.command,
            output: "",
            time: { created: event.properties.timestamp },
          })
          break
        case "session.next.shell.ended":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.activeShell(draft, event.properties.callID)
            if (!match) return
            match.output = event.properties.output
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.step.started":
          batch(() => {
            message.update(event.properties.sessionID, (draft) => {
              if (draft.some((message) => message.id === event.properties.assistantMessageID)) return
              const currentAssistant = message.activeAssistant(draft)
              if (currentAssistant) currentAssistant.time.completed = event.properties.timestamp
            })
            message.prepend(event.properties.sessionID, {
              id: event.properties.assistantMessageID,
              type: "assistant",
              agent: event.properties.agent,
              model: event.properties.model,
              content: [],
              ...(event.properties.snapshot ? { snapshot: { start: event.properties.snapshot } } : {}),
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          message.update(event.properties.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.properties.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = event.properties.finish
            currentAssistant.cost = event.properties.cost
            currentAssistant.tokens = event.properties.tokens
            if (event.properties.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.properties.snapshot }
          })
          break
        case "session.next.step.failed":
          message.update(event.properties.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.properties.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.properties.error
          })
          break
        case "session.next.text.started":
          message.update(event.properties.sessionID, (draft) => {
            message.assistant(draft, event.properties.assistantMessageID)?.content.push({
              type: "text",
              id: event.properties.textID,
              text: "",
            })
          })
          break
        case "session.next.text.delta":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestText(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.textID,
            )
            if (match) match.text += event.properties.delta
          })
          break
        case "session.next.text.ended":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestText(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.textID,
            )
            if (match) match.text = event.properties.text
          })
          break
        case "session.next.tool.input.started":
          message.update(event.properties.sessionID, (draft) => {
            message.assistant(draft, event.properties.assistantMessageID)?.content.push({
              type: "tool",
              id: event.properties.callID,
              name: event.properties.name,
              time: { created: event.properties.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status === "pending") match.state.input += event.properties.delta
          })
          break
        case "session.next.tool.input.ended":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status === "pending") match.state.input = event.properties.text
          })
          break
        case "session.next.tool.called":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (!match) return
            match.time.ran = event.properties.timestamp
            match.provider = event.properties.provider
            match.state = { status: "running", input: event.properties.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status !== "running") return
            match.state.structured = event.properties.structured
            match.state.content = [...event.properties.content]
          })
          break
        case "session.next.tool.success":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.properties.structured,
              content: [...event.properties.content],
              result: event.properties.result,
            }
            match.provider = {
              executed: event.properties.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.properties.provider.metadata,
            }
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.tool.failed":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestTool(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.properties.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.properties.result,
            }
            match.provider = {
              executed: event.properties.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.properties.provider.metadata,
            }
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.reasoning.started":
          message.update(event.properties.sessionID, (draft) => {
            message.assistant(draft, event.properties.assistantMessageID)?.content.push({
              type: "reasoning",
              id: event.properties.reasoningID,
              text: "",
              providerMetadata: event.properties.providerMetadata,
            })
          })
          break
        case "session.next.reasoning.delta":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.reasoningID,
            )
            if (match) match.text += event.properties.delta
          })
          break
        case "session.next.reasoning.ended":
          message.update(event.properties.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.properties.assistantMessageID),
              event.properties.reasoningID,
            )
            if (match) {
              match.text = event.properties.text
              if (event.properties.providerMetadata !== undefined)
                match.providerMetadata = event.properties.providerMetadata
            }
          })
          break
        case "session.next.retried":
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          message.prepend(event.properties.sessionID, {
            id: event.properties.messageID,
            type: "compaction",
            reason: event.properties.reason,
            summary: event.properties.text,
            recent: event.properties.recent,
            time: { created: event.properties.timestamp },
          })
          break
        case "reference.updated":
          refreshAll("Failed to refresh location data", [load.reference()])
          break
        case "integration.updated":
          refreshAll("Failed to refresh location data", [
            load.integration(location),
            load.model(location),
            load.provider(location),
          ])
          break
      }
    }

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        handleEvent(event, { directory: metadata.directory, workspaceID: metadata.workspace })
      })
      onCleanup(unsub)
    })

    const result = {
      session: {
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        refresh(sessionID: string) {
          return Effect.runPromise(load.session(sessionID))
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          refresh(sessionID: string) {
            return Effect.runPromise(load.sessionMessages(sessionID))
          },
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          refresh(sessionID: string) {
            return Effect.runPromise(load.sessionPermissions(sessionID))
          },
        },
        question: {
          list(sessionID: string) {
            return store.session.question[sessionID]
          },
          refresh(sessionID: string) {
            return Effect.runPromise(load.sessionQuestions(sessionID))
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          refresh(projectID: string) {
            return Effect.runPromise(load.projectPermissions(projectID))
          },
        },
      },
      location: {
        default() {
          return defaultLocation()
        },
        refresh(ref?: LocationRef) {
          return Effect.runPromise(load.location(ref))
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.agent(ref))
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.command(ref))
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.integration(ref))
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.model(ref))
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.provider(ref))
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.reference(ref))
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          refresh(ref?: LocationRef) {
            return Effect.runPromise(load.skill(ref))
          },
        },
      },
    }

    onMount(() => {
      refreshAll("Failed to refresh default location data", [
        load.location(),
        load.agent(),
        load.integration(),
        load.model(),
        load.provider(),
        load.reference(),
        load.command(),
        load.skill(),
      ])
    })

    return result
  },
})
