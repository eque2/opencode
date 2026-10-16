import { afterAll, expect, test } from "bun:test"
test("[FX5] passes", () => { expect(1).toBe(1) })
afterAll(() => { throw new Error("afterAll hook fails after every test passed") })
