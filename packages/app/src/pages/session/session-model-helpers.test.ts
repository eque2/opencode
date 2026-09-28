import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { Chunk, Option } from "effect"
import { resetSessionModel, restorePromptModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }): UserMessage => ({
  id: "msg",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: input?.agent ?? "build",
  model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
})

type PromptModel = { providerID: string; modelID: string; variant?: string | null }

/** Records every value that a stand-in receives, in call order. */
const recorder = () => {
  let calls = Chunk.empty<unknown>()
  return {
    record: (value: unknown) => {
      calls = Chunk.append(calls, value)
    },
    calls: () => Chunk.toReadonlyArray(calls),
  }
}

/**
 * The local model selection that the helpers read. The model and the variant
 * are Options here; the stand-in hands them out as the `T | undefined` that
 * the real selection returns.
 */
const localSelection = (input: {
  model: Option.Option<{ id: string; provider: { id: string } }>
  variant: Option.Option<string>
  record?: (value: unknown) => void
}) => ({
  model: {
    current: () => Option.getOrUndefined(input.model),
    set: (model: { providerID: string; modelID: string }) => input.record?.(model),
    variant: {
      current: () => Option.getOrUndefined(input.variant),
      set: (variant: string | undefined) => input.record?.(variant),
    },
  },
})

/** The prompt model state that the helpers read, with the stored model as an Option. */
const promptState = (input: { model: Option.Option<PromptModel>; record?: (value: unknown) => void }) => ({
  model: {
    current: () => Option.getOrUndefined(input.model),
    set: (model: PromptModel) => input.record?.(model),
  },
})

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls = recorder()

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.record(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls.calls()).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls = recorder()

    resetSessionModel({
      session: {
        reset() {
          calls.record("reset")
        },
        restore() {},
      },
    })

    expect(calls.calls()).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls = recorder()

    syncPromptModel(
      localSelection({
        model: Option.some({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
        variant: Option.some("high"),
      }),
      promptState({ model: Option.none(), record: calls.record }),
    )

    expect(calls.calls()).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls = recorder()
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      localSelection({
        model: Option.some({ id: model.modelID, provider: { id: model.providerID } }),
        variant: Option.some(model.variant),
      }),
      promptState({ model: Option.some(model), record: calls.record }),
    )

    expect(calls.calls()).toEqual([])
  })
})

describe("restorePromptModel", () => {
  test("restores the persisted prompt model into session selection", () => {
    const calls = recorder()
    const restored = restorePromptModel(
      localSelection({
        model: Option.some({ id: "gpt", provider: { id: "openai" } }),
        variant: Option.none(),
        record: calls.record,
      }),
      promptState({ model: Option.some({ providerID: "anthropic", modelID: "claude", variant: "high" }) }),
    )

    expect(restored).toBe(true)
    expect(calls.calls()).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls = recorder()
    const restored = restorePromptModel(
      localSelection({
        model: Option.some({ id: "gpt", provider: { id: "openai" } }),
        variant: Option.none(),
        record: calls.record,
      }),
      promptState({ model: Option.none() }),
    )

    expect(restored).toBe(false)
    expect(calls.calls()).toEqual([])
  })
})
