import { describe, expect, test, afterAll } from "bun:test"
import { Effect } from "effect"
import { Storage } from "../../src/core/storage"

describe("core.storage", () => {
  test("should list files with after and before range", async () => {
    await Effect.runPromise(Storage.write(["test", "users", "user1"], { name: "user1" }))
    await Effect.runPromise(Storage.write(["test", "users", "user2"], { name: "user2" }))
    await Effect.runPromise(Storage.write(["test", "users", "user3"], { name: "user3" }))
    await Effect.runPromise(Storage.write(["test", "users", "user4"], { name: "user4" }))
    await Effect.runPromise(Storage.write(["test", "users", "user5"], { name: "user5" }))

    const result = await Effect.runPromise(Storage.list({ prefix: ["test", "users"], after: "user2", before: "user4" }))

    expect(result).toEqual([["test", "users", "user3"]])
  })

  test("should list files with after only", async () => {
    const result = await Effect.runPromise(Storage.list({ prefix: ["test", "users"], after: "user3" }))

    expect(result).toEqual([
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  test("should list files with limit", async () => {
    const result = await Effect.runPromise(Storage.list({ prefix: ["test", "users"], limit: 3 }))

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
    ])
  })

  test("should list all files without prefix", async () => {
    const result = await Effect.runPromise(Storage.list())

    expect(result.length).toBeGreaterThan(0)
  })

  test("should list all files with prefix", async () => {
    const result = await Effect.runPromise(Storage.list({ prefix: ["test", "users"] }))

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  afterAll(async () => {
    const testFiles = await Effect.runPromise(Storage.list({ prefix: ["test"] }))

    for (const file of testFiles) {
      await Effect.runPromise(Storage.remove(file))
    }

    const remainingFiles = await Effect.runPromise(Storage.list({ prefix: ["test"] }))
    expect(remainingFiles).toEqual([])
  })
})
