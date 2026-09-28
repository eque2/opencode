import { Effect } from "effect"
import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { createStore } from "solid-js/store"

export function DialogTag(props: { onSelect?: (value: string) => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const project = useProject()

  const [store] = createStore({
    filter: "",
  })

  const [files] = createResource(
    () => [store.filter],
    // A rejected request still puts the resource in its error state, as the old await did.
    () =>
      Effect.runPromise(
        Effect.promise(() =>
          sdk.client.find.files({
            query: store.filter,
            workspace: project.workspace.current(),
          }),
        ).pipe(Effect.map((result) => (result.error ? [] : (result.data ?? []).slice(0, 5)))),
      ),
  )

  const options = createMemo(() =>
    (files() ?? []).map((file) => ({
      value: file,
      title: file,
    })),
  )

  return (
    <DialogSelect
      title="Autocomplete"
      options={options()}
      onSelect={(option) => {
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}
