import { expect, test } from "bun:test"
import { Option } from "effect"
import { createRoot, createSignal } from "solid-js"
import { createPromptInputTransientState } from "@/components/prompt-input/transient-state"

test("resets transient prompt input state when the prompt session changes", () => {
  createRoot((dispose) => {
    const [identity, setIdentity] = createSignal("A")
    const [state, setState] = createPromptInputTransientState(identity, 3)
    setState({
      popover: Option.some("slash"),
      slashMenu: true,
      slashMenuQuery: "compact",
      historyIndex: 2,
      savedPrompt: Option.some({
        prompt: [{ type: "text", content: "draft-A", start: 0, end: 7 }],
        comments: [],
      }),
      draggingType: Option.some("image"),
      mode: "shell",
      applyingHistory: true,
    })

    setIdentity("B")

    expect(state).toMatchObject({
      popover: Option.none(),
      slashMenu: false,
      slashMenuQuery: "",
      historyIndex: -1,
      savedPrompt: Option.none(),
      placeholder: 3,
      draggingType: Option.none(),
      mode: "normal",
      applyingHistory: false,
    })
    dispose()
  })
})
