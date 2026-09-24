import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES, oc2Theme } from "./default-themes"
import { isDesktopTheme, parseDesktopTheme } from "./validate"

const bundledIds = Array.from(new Bun.Glob("*.json").scanSync(`${import.meta.dir}/themes`), (file) =>
  file.slice(0, -".json".length),
).sort()

describe("isDesktopTheme", () => {
  test("covers every bundled theme file", () => {
    expect(Object.keys(DEFAULT_THEMES).sort()).toEqual(bundledIds)
  })

  test("accepts every bundled theme", () => {
    const rejected = Object.entries(DEFAULT_THEMES)
      .filter(([, theme]) => !isDesktopTheme(theme))
      .map(([id]) => id)
    expect(rejected).toEqual([])
  })

  test("rejects a variant that defines both palette and seeds", () => {
    const light = { ...oc2Theme.light, seeds: oc2Theme.dark.palette }
    expect(isDesktopTheme({ ...oc2Theme, light })).toBe(false)
  })

  test("rejects a variant without palette or seeds", () => {
    expect(isDesktopTheme({ ...oc2Theme, dark: { overrides: {} } })).toBe(false)
  })

  test("rejects an override that is neither hex nor a CSS variable", () => {
    const light = { ...oc2Theme.light, overrides: { "text-base": "red" } }
    expect(isDesktopTheme({ ...oc2Theme, light })).toBe(false)
  })
})

describe("parseDesktopTheme", () => {
  test("returns a valid theme unchanged", () => {
    expect(parseDesktopTheme(oc2Theme)).toBe(oc2Theme)
  })

  test("throws for invalid theme JSON", () => {
    expect(() => parseDesktopTheme({ id: "broken" })).toThrow('Theme "broken" does not match the DesktopTheme type')
  })
})
