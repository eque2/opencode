import { expect, test } from "bun:test"
throw new Error("module-level throw before any test")
test("[FX4] never runs", () => { expect(1).toBe(1) })
