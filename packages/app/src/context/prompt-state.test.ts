import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT } from "./prompt-state"

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("keeps the cursor when a prompt is set without a cursor position", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "hello" })
      const [store] = prompt.store
      const next = [{ type: "text" as const, content: "forked", start: 0, end: 6 }]

      prompt.set(next)
      expect(store().prompt).toEqual(next)
      expect(store().cursor).toBe(5)

      prompt.set(next, 6)
      expect(store().cursor).toBe(6)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })
})
