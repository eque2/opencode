import path from "path"
import { Effect, FileSystem, Schema } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

/** The Node FileSystem layer that runs the persistence effects. */
export const fileSystemLayer = LayerNode.compile(LayerNodePlatform.filesystem)

/** Reads a UTF-8 text file. */
export const readText = Effect.fn("TuiPersistence.readText")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(filePath)
})

/** Reads a file and decodes its text with a JSON string codec, for example `Schema.fromJsonString(State)`. */
export function readJson<A>(filePath: string, codec: Schema.Codec<A, string>) {
  return readText(filePath).pipe(Effect.flatMap((text) => Schema.decodeEffect(codec)(text)))
}

/** Replaces a text file and creates its parent directory first. */
export const writeText = Effect.fn("TuiPersistence.writeText")(function* (filePath: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true })
  yield* fs.writeFileString(filePath, content)
})

/** Appends to a text file and creates its parent directory first. */
export const appendText = Effect.fn("TuiPersistence.appendText")(function* (filePath: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true })
  yield* fs.writeFileString(filePath, content, { flag: "a" })
})

/**
 * Encodes a value with a JSON string codec and replaces the file atomically. The text goes to a
 * scoped temporary file in the same directory, which is then renamed over the target. The scope
 * removes the temporary directory after a success and after a failure.
 */
export function writeJsonAtomic<A>(filePath: string, codec: Schema.Codec<A, string>, value: A) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = path.dirname(filePath)
    yield* fs.makeDirectory(directory, { recursive: true })
    const content = yield* Schema.encodeEffect(codec)(value)
    const temporary = yield* fs.makeTempFileScoped({
      directory,
      prefix: `${path.basename(filePath)}.`,
      suffix: ".tmp",
    })
    yield* fs.writeFileString(temporary, content)
    yield* fs.rename(temporary, filePath)
  }).pipe(Effect.scoped, Effect.withSpan("TuiPersistence.writeJsonAtomic"))
}
