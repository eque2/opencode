import { expect } from "bun:test"
import { Effect } from "effect"
import { ConfigParse } from "../../src/config/parse"

export async function snapshot(file: string, actual: string) {
  const value = Effect.runSync(ConfigParse.parseJsonc(actual, file))
  if (process.env.UPDATE_CONFIG_FIXTURES === "1") await Bun.write(file, actual)
  expect(value).toEqual(Effect.runSync(ConfigParse.parseJsonc(await Bun.file(file).text(), file)))
}
