import { describe, expect, test } from "bun:test"

describe("tui attach", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()

    expect(source).toContain('import("../tui/layer")')
    expect(source).toMatch(/import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toMatch(/from ["']\.\.\/tui\/layer["']/)
    expect(source).not.toMatch(/from ["']@\/plugin\/tui\/runtime["']/)
    expect(source).not.toContain('import("./app")')
  })
})
