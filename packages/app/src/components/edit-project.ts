import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { Data, Effect } from "effect"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"

// Wraps a rejected project update, so the save mutation fails with a typed error.
class ProjectUpdateError extends Data.TaggedError("App.ProjectUpdateError")<{ readonly cause: unknown }> {}

export function createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const [store, setStore] = createStore({
    name: defaultName(),
    color: props.project.icon?.color,
    iconOverride: props.project.icon?.override,
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
  })
  let iconInput: HTMLInputElement | undefined

  function selectFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result !== "string") return
      setStore("iconOverride", result)
      setStore("iconHover", false)
    }
    reader.readAsDataURL(file)
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", false)
    const file = event.dataTransfer?.files[0]
    if (file) selectFile(file)
  }

  function dragOver(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", true)
  }

  function dragLeave() {
    setStore("dragOver", false)
  }

  // Solid types a change handler on an <input> with the input as its currentTarget.
  function inputChange(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0]
    if (file) selectFile(file)
  }

  function iconClick() {
    if (store.iconOverride && store.iconHover) {
      setStore("iconOverride", "")
      return
    }
    iconInput?.click()
  }

  const saveProject = Effect.gen(function* () {
    const name = store.name.trim() === folderName() ? "" : store.name.trim()
    const start = store.startup.trim()

    if (props.project.id && props.project.id !== "global") {
      const projectID = props.project.id
      const protocol = yield* Effect.promise(() => serverCtx().sdk.protocol)
      if (protocol !== "v1") return
      const project = yield* Effect.tryPromise({
        try: () =>
          serverCtx().sdk.client.project.update({
            projectID,
            directory: props.project.worktree,
            name,
            icon: { color: store.color || "", override: store.iconOverride || "" },
            commands: { start },
          }),
        catch: (cause) => new ProjectUpdateError({ cause }),
      }).pipe(Effect.map((result) => result.data))
      if (!project) return
      // const project = await serverCtx().sdk.api.project.update({
      //   projectID: props.project.id,
      //   name,
      //   icon: { color: store.color || "", override: store.iconOverride || "" },
      //   commands: { start },
      // })
      serverCtx().sync.set("project", (items) =>
        items.map((item) => (item.id === project.id ? normalizeProjectInfo(project) : item)),
      )
      serverCtx().sync.project.icon(props.project.worktree, store.iconOverride || undefined)
      dialog.close()
      return
    }

    serverCtx().sync.project.meta(props.project.worktree, {
      name,
      icon: { color: store.color || undefined, override: store.iconOverride || undefined },
      commands: { start: start || undefined },
    })
    dialog.close()
  })

  const save = useMutation(() => ({
    mutationFn: () => Effect.runPromise(saveProject),
  }))

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (save.isPending) return
    save.mutate()
  }

  return {
    store,
    setStore,
    folderName,
    defaultName,
    save,
    submit,
    drop,
    dragOver,
    dragLeave,
    inputChange,
    iconClick,
    close: () => {
      dialog.close()
    },
    setIconInput: (input: HTMLInputElement) => {
      iconInput = input
    },
  }
}
