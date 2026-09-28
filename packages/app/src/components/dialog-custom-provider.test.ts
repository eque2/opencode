import { describe, expect, test } from "bun:test"
import { HashSet, Option } from "effect"
import { validateCustomProvider } from "./dialog-custom-provider-form"

const t = (key: string) => key
const none = Option.none<string>()

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: { id: none, name: none } }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: { key: none, value: none } },
          { row: "h1", key: "", value: "", err: { key: none, value: none } },
        ],
        err: { providerID: none, name: none, baseURL: none },
      },
      t,
      disabledProviders: [],
      existingProviderIDs: HashSet.empty(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: Option.none(),
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: { id: none, name: none } },
          { row: "m1", id: "model-a", name: "Model A 2", err: { id: none, name: none } },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: { key: none, value: none } },
          { row: "h1", key: "authorization", value: "two", err: { key: none, value: none } },
        ],
        err: { providerID: none, name: none, baseURL: none },
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: HashSet.make("custom-provider"),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toEqual(Option.none())
    expect(result.models[1]).toEqual({
      id: Option.some("provider.custom.error.duplicate"),
      name: Option.none(),
    })
    expect(result.headers[1]).toEqual({
      key: Option.some("provider.custom.error.duplicate"),
      value: Option.none(),
    })
  })
})
