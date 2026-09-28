import { batch } from "solid-js"
import type { Path, Workspace } from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { Effect, Option, Predicate } from "effect"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

type ProjectStore = {
  project: {
    id?: string
    worktree?: string
    mainDir?: string
  }
  instance: {
    path: Path
  }
  workspace: {
    current?: string
    list: Workspace[]
    status: Record<string, WorkspaceStatus>
  }
}

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies Path

    const [store, setStore] = createStore<ProjectStore>({
      project: {},
      instance: {
        path: defaultPath,
      },
      workspace: {
        list: [],
        status: {},
      },
    })

    // The SDK resolves HTTP errors as `{ error }` instead of rejecting, so a
    // rejection here is a defect; Effect.promise keeps it as the rejection
    // value that callers of `sync()` see.
    const syncProject = Effect.gen(function* () {
      const workspace = store.workspace.current
      const [instancePath, project] = yield* Effect.all(
        [
          Effect.promise(() => sdk.client.path.get({ workspace })),
          Effect.promise(() => sdk.client.project.current({ workspace })),
        ],
        { concurrency: "unbounded" },
      )
      const mainDir = yield* Option.fromNullishOr(project.data?.id).pipe(
        Option.filter(Predicate.isTruthy),
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (projectID) =>
            Effect.promise(() => sdk.client.project.directories({ projectID, workspace })).pipe(
              Effect.map((directories) =>
                Option.fromNullishOr(directories.data?.findLast((item) => item.strategy === undefined)?.directory),
              ),
            ),
        }),
      )
      batch(() => {
        setStore("instance", "path", reconcile(instancePath.data || defaultPath))
        setStore("project", "id", project.data?.id)
        setStore("project", "worktree", project.data?.worktree)
        setStore("project", "mainDir", Option.getOrUndefined(mainDir))
      })
    })

    const syncWorkspace = Effect.gen(function* () {
      const listed = yield* Effect.tryPromise(() => sdk.client.experimental.workspace.list()).pipe(Effect.option)
      const workspaces = Option.flatMapNullishOr(listed, (response) => response.data)
      if (Option.isNone(workspaces)) return
      const status = yield* Effect.tryPromise(() => sdk.client.experimental.workspace.status()).pipe(Effect.option)
      const next = Object.fromEntries(
        Option.getOrElse(
          Option.flatMapNullishOr(status, (response) => response.data),
          () => [],
        ).map((item) => [item.workspaceID, item.status]),
      )

      batch(() => {
        setStore("workspace", "list", reconcile(workspaces.value))
        setStore("workspace", "status", reconcile(next))
        if (!workspaces.value.some((item) => item.id === store.workspace.current)) {
          setStore(
            "workspace",
            produce((workspace) => {
              delete workspace.current
            }),
          )
        }
      })
    })

    sdk.event.on("event", (event) => {
      if (event.payload.type === "workspace.status") {
        setStore("workspace", "status", event.payload.properties.workspaceID, event.payload.properties.status)
      }
    })

    return {
      data: store,
      project: () => store.project.id,
      instance: {
        path: () => store.instance.path,
        directory: () => store.instance.path.directory,
      },
      workspace: {
        current: () => store.workspace.current,
        set: (next?: string | null) => {
          const workspace = Option.getOrUndefined(Option.fromNullishOr(next))
          if (store.workspace.current === workspace) return
          setStore("workspace", "current", workspace)
        },
        list: () => store.workspace.list,
        get: (workspaceID: string) => store.workspace.list.find((item) => item.id === workspaceID),
        status: (workspaceID: string) => store.workspace.status[workspaceID],
        statuses: () => store.workspace.status,
        sync: () => Effect.runPromise(syncWorkspace),
      },
      sync: () => Effect.runPromise(syncProject),
    }
  },
})
