import { describe, expect, test } from "bun:test"
import { ConfigPlugin } from "../../src/config/plugin"

describe("ConfigPlugin.pluginSpecifier", () => {
  test("returns a string spec unchanged", () => {
    expect(ConfigPlugin.pluginSpecifier("example-plugin@1.0.0")).toBe("example-plugin@1.0.0")
  })

  test("returns the specifier of a tuple spec", () => {
    expect(ConfigPlugin.pluginSpecifier(["example-plugin", { mode: "fast" }])).toBe("example-plugin")
  })
})

describe("ConfigPlugin.pluginOptions", () => {
  test("returns no options for a string spec", () => {
    expect(ConfigPlugin.pluginOptions("example-plugin")).toBeUndefined()
  })

  test("returns the options of a tuple spec", () => {
    expect(ConfigPlugin.pluginOptions(["example-plugin", { mode: "fast" }])).toEqual({ mode: "fast" })
  })
})

describe("ConfigPlugin.deduplicatePluginOrigins", () => {
  test("keeps the last origin for each npm package and keeps their order", () => {
    const origins: ConfigPlugin.Origin[] = [
      { spec: "first@1.0.0", source: "/global/opencode.json", scope: "global" },
      { spec: "second", source: "/global/opencode.json", scope: "global" },
      { spec: ["first@2.0.0", { mode: "fast" }], source: "/project/opencode.json", scope: "local" },
    ]

    expect(ConfigPlugin.deduplicatePluginOrigins(origins)).toEqual([origins[1], origins[2]])
  })

  test("dedupes file specs on the exact file URL", () => {
    const origins: ConfigPlugin.Origin[] = [
      { spec: "file:///plugins/a.ts", source: "/global/opencode.json", scope: "global" },
      { spec: "file:///other/a.ts", source: "/project/opencode.json", scope: "local" },
      { spec: "file:///plugins/a.ts", source: "/project/opencode.json", scope: "local" },
    ]

    expect(ConfigPlugin.deduplicatePluginOrigins(origins)).toEqual([origins[1], origins[2]])
  })
})
