import { describe, expect, test } from "bun:test"
import { Chunk, MutableHashMap } from "effect"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    let calls = Chunk.empty<string>()
    const result = ensureSessionKey(
      "dir/a",
      (key) => {
        calls = Chunk.append(calls, `touch:${key}`)
      },
      (key) => {
        calls = Chunk.append(calls, `seed:${key}`)
      },
    )

    expect(result).toBe("dir/a")
    expect(Chunk.toReadonlyArray(calls)).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: MutableHashMap.make(["k1", 1], ["k2", 2], ["k3", 3], ["k4", 4]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      max: 1,
      used: MutableHashMap.make(["k1", 1], ["k2", 2]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})
