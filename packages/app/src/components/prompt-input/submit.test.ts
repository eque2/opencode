import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Deferred, Effect, Exit, Option } from "effect"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { DirectorySDK } from "@/context/sdk"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

type SubmitInput = Parameters<typeof createPromptSubmit>[0]
type PromptRequest = Parameters<DirectorySDK["api"]["session"]["prompt"]>[0]
type StoredSession = { id: string; title?: string }

let createdClients: string[] = []
let createdSessions: string[] = []
let sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
let enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
let optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
let optimisticSeeded: boolean[] = []
const storedSessions: Record<string, StoredSession[]> = {}
let promoted: Array<{ directory: string; sessionID: string }> = []
let sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
let syncedDirectories: string[] = []
let promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
let sentPrompts: string[] = []
let promptInputs: PromptRequest[] = []
let sentCommands: unknown[] = []
let commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: Option.Option<string> = Option.none()
let permissionServer = "server-a"
let createSessionGate: Option.Option<Deferred.Deferred<void>> = Option.none()

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Effect.runPromise(Effect.succeed(true)) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => promptStore.model,
    set: () => {},
  },
  reset: () => {},
  set: () => {},
  context: {
    add: () => {},
    remove: () => {},
    removeComment: () => {},
    updateComment: () => {},
    replaceComments: () => {},
    items: () => [],
  },
  capture: () => prompt,
}

const promptLength = (value: Prompt) =>
  value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0)

const submitInput = (session: Option.Option<{ id: string }>): SubmitInput => ({
  prompt,
  info: () => Option.getOrUndefined(session),
  imageAttachments: () => [],
  commentCount: () => 0,
  autoAccept: () => false,
  mode: () => "normal",
  working: () => false,
  // The test composer has no editor element.
  editor: () => Option.none(),
  queueScroll: () => {},
  promptLength,
  addToHistory: () => {},
  resetHistoryNavigation: () => {},
  setMode: () => {},
  closePopover: () => {},
})

const clientFor = (directory: string) => {
  createdClients = [...createdClients, directory]
  return {
    api: {
      session: {
        create: (input: (typeof sessionCreateInputs)[number]) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const gate = createSessionGate
              if (Option.isSome(gate)) yield* Deferred.await(gate.value)
              const location = input.location?.directory ?? directory
              createdSessions = [...createdSessions, location]
              sessionCreateInputs = [...sessionCreateInputs, input]
              return {
                id: `session-${createdSessions.length}`,
                projectID: "project",
                agent: input.agent,
                model: input.model,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 1, updated: 1 },
                title: `New session ${createdSessions.length}`,
                location: { directory: location },
              }
            }),
          ),
        prompt: (input: PromptRequest) =>
          Effect.runPromise(
            Effect.sync(() => {
              sentPrompts = [...sentPrompts, directory]
              promptInputs = [...promptInputs, input]
            }),
          ),
        command: (input: unknown) =>
          Effect.runPromise(
            Effect.sync(() => {
              sentCommands = [...sentCommands, input]
            }),
          ),
        shell: (input: { sessionID: string; id?: string; command: string }) =>
          Effect.runPromise(
            Effect.sync(() => {
              sentShell = [...sentShell, input]
            }),
          ),
      },
    },
    worktree: {
      create: () => Effect.runPromise(Effect.succeed({ data: { directory: `${directory}/new` } })),
    },
  }
}

let mocking = true
afterAll(() => {
  mocking = false
})

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rootClient = clientFor("/repo/main")
      // Bun keeps a module mock for the rest of the process. Each mock keeps the real exports, so a later test file
      // that imports another name from the same module still finds it.
      const actual: Record<string, Record<string, unknown>> = Object.fromEntries(
        yield* Effect.promise(() =>
          Promise.all(
            [
              "@solidjs/router",
              "@/context/local",
              "@/context/permission",
              "@/context/tabs",
              "@/context/prompt",
              "@/context/layout",
              "@/context/sdk",
              "@/context/sync",
              "@/context/server-sync",
              "@/context/platform",
              "@/context/language",
            ].map(async (path) => [path, { ...(await import(path)) }] as const),
          ),
        ),
      )

      mock.module("@solidjs/router", () => ({
        ...actual["@solidjs/router"],
        useNavigate: () => () => {},
        useParams: () => params,
        useLocation: () => ({}),
        useSearchParams: () => [search, () => {}],
      }))

      // Bun keeps a module mock for the rest of the process, so a later test file (bootstrap.test.ts on Linux)
      // would get this fake client. The real module is kept, and the fake answers only while these tests run.
      const sdk = { ...(yield* Effect.promise(() => import("@opencode-ai/sdk/v2/client"))) }
      mock.module("@opencode-ai/sdk/v2/client", () => ({
        ...sdk,
        createOpencodeClient: (input: Parameters<typeof sdk.createOpencodeClient>[0] & { directory: string }) => {
          if (!mocking) return sdk.createOpencodeClient(input)
          createdClients = [...createdClients, input.directory]
          return clientFor(input.directory)
        },
      }))

      const toast = yield* Effect.promise(() => import("@opencode-ai/ui/toast"))
      mock.module("@opencode-ai/ui/toast", () => ({
        ...toast,
        Toast: { Region: () => [] },
        showToast: () => 0,
      }))

      const encode = { ...(yield* Effect.promise(() => import("@opencode-ai/core/util/encode"))) }
      mock.module("@opencode-ai/core/util/encode", () => ({
        ...encode,
        base64Encode: (value: string) => (mocking ? value : encode.base64Encode(value)),
      }))

      mock.module("@/context/local", () => ({
        ...actual["@/context/local"],
        useLocal: () => ({
          model: {
            current: () => ({ id: "model", provider: { id: "provider" } }),
            variant: { current: () => Option.getOrUndefined(variant) },
          },
          agent: {
            current: () => ({ name: "agent" }),
          },
          session: {
            promote(directory: string, sessionID: string) {
              promoted = [...promoted, { directory, sessionID }]
            },
          },
        }),
      }))

      mock.module("@/context/permission", () => {
        const state = (server: string) => ({
          enableAutoAccept(sessionID: string, directory: string) {
            enabledAutoAccept = [...enabledAutoAccept, { server, sessionID, directory }]
          },
        })
        return {
          ...actual["@/context/permission"],
          usePermission: () => ({ currentServerState: () => state(permissionServer) }),
        }
      })

      const server = yield* Effect.promise(() => import("@/context/server"))
      mock.module("@/context/server", () => ({
        ...server,
        useServer: () => ({ key: "server-key" }),
      }))

      mock.module("@/context/tabs", () => ({
        ...actual["@/context/tabs"],
        useTabs: () => ({
          draft: () => ({ server: "project-server" }),
          promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
            promotedDrafts = [...promotedDrafts, { draftID, ...session }]
          },
        }),
      }))

      mock.module("@/context/prompt", () => ({
        ...actual["@/context/prompt"],
        usePrompt: () => prompt,
      }))

      mock.module("@/context/layout", () => ({
        ...actual["@/context/layout"],
        useLayout: () => ({
          handoff: {
            setTabs: () => {},
          },
        }),
      }))

      mock.module("@/context/sdk", () => ({
        ...actual["@/context/sdk"],
        useSDK: () => {
          const sdk = {
            scope: "local",
            directory: "/repo/main",
            client: rootClient,
            api: rootClient.api,
            url: "http://localhost:4096",
            createClient(opts: any) {
              return clientFor(opts.directory)
            },
          }
          return () => sdk
        },
      }))

      mock.module("@/context/sync", () => ({
        ...actual["@/context/sync"],
        useSync: () => () => ({
          data: { command: commands },
          session: {
            optimistic: {
              add: (value: {
                directory?: string
                sessionID?: string
                message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
              }) => {
                optimistic = [...optimistic, value]
                optimisticSeeded = [
                  ...optimisticSeeded,
                  !!value.directory &&
                    !!value.sessionID &&
                    !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
                ]
              },
              remove: () => {},
            },
          },
          set: () => {},
        }),
      }))

      mock.module("@/context/server-sync", () => ({
        ...actual["@/context/server-sync"],
        useServerSync: () => () => ({
          session: {
            remember: () => {},
            set: () => {},
            sync: () =>
              Effect.runPromise(
                Effect.sync(() => {
                  serverSessionSyncs++
                }),
              ),
          },
          child: (directory: string) => {
            syncedDirectories = [...syncedDirectories, directory]
            storedSessions[directory] ??= []
            return [
              { session: storedSessions[directory] },
              (key: string, next: StoredSession[] | ((list: StoredSession[]) => StoredSession[])) => {
                if (key !== "session") return
                if (typeof next === "function") {
                  storedSessions[directory] = next(storedSessions[directory] ?? [])
                  return
                }
                storedSessions[directory] = next
              },
            ]
          },
        }),
      }))

      mock.module("@/context/platform", () => ({
        ...actual["@/context/platform"],
        usePlatform: () => ({
          fetch: fetch,
        }),
      }))

      mock.module("@/context/language", () => ({
        ...actual["@/context/language"],
        useLanguage: () => ({
          t: (key: string) => key,
        }),
      }))

      const mod = yield* Effect.promise(() => import("./submit"))
      createPromptSubmit = mod.createPromptSubmit
    }),
  ),
)

beforeEach(() => {
  createdClients = []
  createdSessions = []
  sessionCreateInputs = []
  enabledAutoAccept = []
  optimistic = []
  optimisticSeeded = []
  promoted = []
  promotedDrafts = []
  sentPrompts = []
  promptInputs = []
  sentCommands = []
  commands = []
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell = []
  syncedDirectories = []
  selected = "/repo/worktree-a"
  variant = Option.none()
  permissionServer = "server-a"
  createSessionGate = Option.none()
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = createPromptSubmit({
          ...submitInput(Option.none()),
          mode: () => "shell",
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => {},
          onSubmit: () => {},
        })

        const event = new Event("submit")

        yield* Effect.promise(() => submit.handleSubmit(event))
        selected = "/repo/worktree-b"
        yield* Effect.promise(() => submit.handleSubmit(event))

        expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
        expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
        expect(sessionCreateInputs).toEqual([
          {
            agent: "agent",
            model: { id: "model", providerID: "provider" },
            location: { directory: "/repo/worktree-a" },
          },
          {
            agent: "agent",
            model: { id: "model", providerID: "provider" },
            location: { directory: "/repo/worktree-b" },
          },
        ])
        expect(sentShell).toEqual([
          expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
          expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
        ])
        expect(syncedDirectories).toEqual([
          "/repo/worktree-a",
          "/repo/worktree-a",
          "/repo/worktree-b",
          "/repo/worktree-b",
        ])
        expect(serverSessionSyncs).toBe(0)
        expect(promoted).toEqual([
          { directory: "/repo/worktree-a", sessionID: "session-1" },
          { directory: "/repo/worktree-b", sessionID: "session-2" },
        ])
        expect(syncedDirectories).toEqual([
          "/repo/worktree-a",
          "/repo/worktree-a",
          "/repo/worktree-b",
          "/repo/worktree-b",
        ])
      }),
    ))

  test("applies auto-accept to newly created sessions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = createPromptSubmit({
          ...submitInput(Option.none()),
          autoAccept: () => true,
          mode: () => "shell",
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => {},
          onSubmit: () => {},
        })

        const event = new Event("submit")

        yield* Effect.promise(() => submit.handleSubmit(event))

        expect(enabledAutoAccept).toEqual([
          { server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" },
        ])
      }),
    ))

  test("keeps auto-accept bound to the submission server", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        createSessionGate = Option.some(gate)
        const submit = createPromptSubmit({
          ...submitInput(Option.none()),
          autoAccept: () => true,
          mode: () => "shell",
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => {},
          onSubmit: () => {},
        })

        const result = submit.handleSubmit(new Event("submit"))
        permissionServer = "server-b"
        yield* Deferred.done(gate, Exit.void)
        yield* Effect.promise(() => result)

        expect(enabledAutoAccept).toEqual([
          { server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" },
        ])
      }),
    ))

  test("promotes drafts using the selected project's server", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        search = { draftId: "draft-1" }
        const submit = createPromptSubmit({
          ...submitInput(Option.none()),
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => {},
          onSubmit: () => {},
        })

        yield* Effect.promise(() => submit.handleSubmit(new Event("submit")))

        expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
      }),
    ))

  test("includes the selected variant on optimistic prompts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        params = { id: "session-1" }
        variant = Option.some("high")

        const submit = createPromptSubmit({
          ...submitInput(Option.some({ id: "session-1" })),
          onSubmit: () => {},
        })

        const event = new Event("submit")

        yield* Effect.promise(() => submit.handleSubmit(event))
        yield* Effect.sleep("0 millis")

        expect(optimistic).toHaveLength(1)
        expect(optimistic[0]).toMatchObject({
          message: {
            agent: "agent",
            model: { providerID: "provider", modelID: "model", variant: "high" },
          },
        })
        expect(sentPrompts).toEqual(["/repo/main"])
        expect(promptInputs[0]).toMatchObject({
          sessionID: "session-1",
          text: "ls",
          files: [],
          agents: [],
        })
        expect(promptInputs[0]?.id).toStartWith("msg_")
        expect(promptInputs[0]?.legacyParts).toEqual([{ id: expect.stringMatching(/^prt_/), type: "text", text: "ls" }])
      }),
    ))

  test("submits slash commands through the current session API", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        params = { id: "session-1" }
        variant = Option.some("high")
        commands = [...commands, { name: "review" }]
        promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

        const submit = createPromptSubmit(submitInput(Option.some({ id: "session-1" })))

        yield* Effect.promise(() => submit.handleSubmit(new Event("submit")))

        expect(sentCommands).toEqual([
          {
            sessionID: "session-1",
            id: expect.stringMatching(/^msg_/),
            command: "review",
            arguments: "staged changes",
            agent: "agent",
            model: { id: "model", providerID: "provider", variant: "high" },
            files: [],
          },
        ])
        expect(serverSessionSyncs).toBe(0)
      }),
    ))

  test("uses an injected model selection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        params = { id: "session-1" }
        const model = {
          current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
          variant: { current: () => "draft-variant" },
        }
        const submit = createPromptSubmit({
          ...submitInput(Option.some({ id: "session-1" })),
          model,
        })

        yield* Effect.promise(() => submit.handleSubmit(new Event("submit")))

        expect(optimistic[0]).toMatchObject({
          message: {
            model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
          },
        })
      }),
    ))

  test("seeds new sessions before optimistic prompts are added", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = createPromptSubmit({
          ...submitInput(Option.none()),
          newSessionWorktree: () => selected,
          onNewSessionWorktreeReset: () => {},
          onSubmit: () => {},
        })

        const event = new Event("submit")

        yield* Effect.promise(() => submit.handleSubmit(event))

        expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
        expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
        expect(optimisticSeeded).toEqual([true])
      }),
    ))
})
