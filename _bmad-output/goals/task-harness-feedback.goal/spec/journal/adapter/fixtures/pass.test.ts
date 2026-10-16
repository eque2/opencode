import { describe, expect, test } from "bun:test"
test("[FX2] first pass", () => { expect(2 + 2).toBe(4) })
describe("group", () => { test("[FX2] second pass", () => { expect("x").toContain("x") }) })
