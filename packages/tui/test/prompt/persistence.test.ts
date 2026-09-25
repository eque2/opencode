import { expect, test } from "bun:test"
import path from "path"
import { Effect, FileSystem, Schema } from "effect"
import {
  appendText,
  fileSystemLayer,
  readJson,
  readText,
  writeJsonAtomic,
  writeText,
} from "../../src/util/persistence"

const State = Schema.Struct({ value: Schema.Number }).annotate({ identifier: "TuiPersistenceTest.State" })
const StateFile = Schema.fromJsonString(State)

test("persistence creates parent directories and supports text, append, and JSON", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-tui-persistence-" })

      const textPath = path.join(root, "nested", "state.jsonl")
      yield* writeText(textPath, "one\n")
      yield* appendText(textPath, "two\n")
      expect(yield* readText(textPath)).toBe("one\ntwo\n")

      const jsonPath = path.join(root, "other", "state.json")
      yield* writeJsonAtomic(jsonPath, StateFile, { value: 1 })
      expect(yield* readJson(jsonPath, StateFile)).toEqual({ value: 1 })
      yield* writeJsonAtomic(jsonPath, StateFile, { value: 2 })
      expect(yield* readJson(jsonPath, StateFile)).toEqual({ value: 2 })
      // The atomic write removes its temporary file and directory.
      expect(yield* fs.readDirectory(path.dirname(jsonPath))).toEqual(["state.json"])
    }).pipe(Effect.scoped, Effect.provide(fileSystemLayer)),
  )
})
