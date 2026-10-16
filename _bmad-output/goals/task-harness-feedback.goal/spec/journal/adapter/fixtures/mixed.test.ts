import { describe, expect, test } from "bun:test"

test("[FX1] top pass & <ok>", () => { expect(1).toBe(1) })
test("[FX1] top fail", () => { expect(1).toBe(2) })
test.skip("[FX1] skipped", () => { expect(1).toBe(1) })
test.todo("[FX1] todo")
describe("outer", () => {
  describe("inner", () => {
    test("[FX1] nested pass", () => { expect(true).toBe(true) })
  })
  test("[FX1] outer pass", () => { expect("a").toBe("a") })
})
