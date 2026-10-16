import fs from "node:fs"
import { expect, test } from "bun:test"
test("[FX6] edits its own file", () => {
  fs.appendFileSync(import.meta.path, "\n// edited during the run\n")
  expect(1).toBe(1)
})

// edited during the run
