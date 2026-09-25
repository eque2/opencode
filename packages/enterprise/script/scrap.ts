import { Effect } from "effect"
import { Storage } from "../src/core/storage"

// read share id from args
const args = process.argv.slice(2)
if (args.length !== 1) {
  console.error("Usage: bun script/scrap.ts <shareID>")
  process.exit(1)
}
const shareID = args[0]

await Effect.runPromise(
  Effect.gen(function* () {
    yield* Storage.remove(["share", shareID])
    const list = yield* Storage.list({ prefix: ["share_data", shareID] })
    for (const item of list) {
      yield* Storage.remove(item)
    }
  }),
)
