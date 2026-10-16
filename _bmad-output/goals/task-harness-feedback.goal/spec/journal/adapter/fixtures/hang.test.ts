import { test } from "bun:test"
test("[FX7] hangs with no output", async () => { await new Promise(() => {}) }, 600000)
