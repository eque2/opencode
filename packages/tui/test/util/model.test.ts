import { describe, expect, test } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2"
import { HashMap, Option } from "effect"
import { get, index, name, parse } from "../../src/util/model"

const providers: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "api",
    env: [],
    options: {},
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-20250514",
          url: "https://example.com/claude-sonnet-4-20250514",
          npm: "@ai-sdk/anthropic",
        },
        name: "Claude Sonnet 4",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-05-14",
      },
    },
  },
]

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("indexes providers by id in a HashMap", () => {
    const indexed = index(providers)
    expect(HashMap.isHashMap(indexed)).toBe(true)
    expect(HashMap.size(indexed)).toBe(1)
    expect(Option.map(HashMap.get(indexed, "anthropic"), (item) => item.name)).toEqual(Option.some("Anthropic"))
    expect(HashMap.size(index(undefined))).toBe(0)
  })

  test("finds a model through the indexed providers", () => {
    const indexed = index(providers)
    expect(Option.map(get(indexed, "anthropic", "claude-sonnet-4-20250514"), (model) => model.name)).toEqual(
      Option.some("Claude Sonnet 4"),
    )
    expect(Option.isNone(get(indexed, "anthropic", "missing"))).toBe(true)
    expect(Option.isNone(get(indexed, "missing", "claude-sonnet-4-20250514"))).toBe(true)
    expect(name(indexed, "anthropic", "claude-sonnet-4-20250514")).toBe("Claude Sonnet 4")
    expect(name(indexed, "missing", "raw-model")).toBe("raw-model")
  })

  test("finds a model through a provider array", () => {
    expect(Option.map(get(providers, "anthropic", "claude-sonnet-4-20250514"), (model) => model.name)).toEqual(
      Option.some("Claude Sonnet 4"),
    )
    expect(Option.isNone(get(providers, "missing", "claude-sonnet-4-20250514"))).toBe(true)
    expect(name(providers, "anthropic", "claude-sonnet-4-20250514")).toBe("Claude Sonnet 4")
    expect(name(providers, "anthropic", "raw-model")).toBe("raw-model")
  })

  test("falls back to the model id without providers", () => {
    expect(Option.isNone(get(undefined, "anthropic", "claude-sonnet-4-20250514"))).toBe(true)
    expect(name(undefined, "anthropic", "raw-model")).toBe("raw-model")
  })
})
