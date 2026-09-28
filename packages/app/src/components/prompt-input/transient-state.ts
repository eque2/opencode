import { Option } from "effect"
import { createComputed, on, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { PromptHistoryEntry } from "./history"

export type PromptInputTransientState = {
  popover: Option.Option<"at" | "slash">
  slashMenu: boolean
  slashMenuQuery: string
  historyIndex: number
  savedPrompt: Option.Option<PromptHistoryEntry>
  placeholder: number
  draggingType: Option.Option<"image" | "@mention">
  mode: "normal" | "shell"
  applyingHistory: boolean
}

function resetPromptInputTransientState(setStore: SetStoreFunction<PromptInputTransientState>) {
  setStore({
    popover: Option.none(),
    slashMenu: false,
    slashMenuQuery: "",
    historyIndex: -1,
    savedPrompt: Option.none(),
    draggingType: Option.none(),
    mode: "normal",
    applyingHistory: false,
  })
}

export function createPromptInputTransientState(identity: Accessor<unknown>, placeholder: number) {
  const [store, setStore] = createStore<PromptInputTransientState>({
    popover: Option.none(),
    slashMenu: false,
    slashMenuQuery: "",
    historyIndex: -1,
    savedPrompt: Option.none(),
    placeholder,
    draggingType: Option.none(),
    mode: "normal",
    applyingHistory: false,
  })

  createComputed(on(identity, () => resetPromptInputTransientState(setStore), { defer: true }))

  return [store, setStore] as const
}
