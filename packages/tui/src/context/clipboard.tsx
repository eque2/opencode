import { Effect, Option } from "effect"
import { createContext, type JSX, useContext } from "solid-js"
import { read, write } from "../clipboard"

export type ClipboardContent = Readonly<{ data: string; mime: string }>
export type ClipboardService = Readonly<{
  read?(): Promise<ClipboardContent | undefined>
  write?(text: string): Promise<void>
}>
// Components await the clipboard, so the service runs each Effect program to a Promise.
const clipboard: ClipboardService = {
  read: () => Effect.runPromise(read().pipe(Effect.map(Option.getOrUndefined))),
  write: (text) => Effect.runPromise(write(text)),
}
const ClipboardContext = createContext(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; children: JSX.Element }) {
  return <ClipboardContext.Provider value={props.value ?? clipboard}>{props.children}</ClipboardContext.Provider>
}

export function useClipboard() {
  return useContext(ClipboardContext)
}
