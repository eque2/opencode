// Live check for the datadog-log-sink goal: sends one record through the real sink to the real Datadog intake.
//
// Run it from the worktree root, in your own shell, with the key in the environment (never paste it into a chat):
//   DD_API_KEY=… bun _bmad-output/goals/datadog-log-sink.goal/live-check.ts
// Add DD_APP_KEY=… (a Datadog application key with logs_read_data) to let the script find the record through the
// Logs search API and print its id. Without it, the script prints the marker to search for in the Datadog UI.
import { ConfigProvider, Effect, Logger, Option } from "../../../packages/core/node_modules/effect/dist/index.js"
import { FetchHttpClient } from "../../../packages/core/node_modules/effect/dist/unstable/http/index.js"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Datadog } from "../../../packages/core/src/observability/datadog"

const marker = `opencode-live-check-${crypto.randomUUID()}`
// An empty config dir, so only the env configures this run.
const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-check-"))

const settings = await Datadog.provider({ env: process.env, configDir }).pipe(
  Effect.flatMap((provider) => Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider)))),
  Effect.runPromise,
)

if (Option.isNone(settings)) {
  console.error("The Datadog sink is off. Set DD_API_KEY in the environment and try again.")
  process.exit(1)
}

await Effect.gen(function* () {
  const logger = yield* Datadog.logger(settings.value)
  yield* Effect.logInfo(marker, { check: "datadog-log-sink live verdict" }).pipe(
    Effect.annotateLogs({ category: "cli.live-check" }),
    Effect.provide(Logger.layer([logger])),
  )
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)

console.log(`sent through the sink: message=${marker} service=${settings.value.service} site=${settings.value.site}`)

const appKey = process.env.DD_APP_KEY
if (!appKey) {
  console.log(`Search the Datadog Logs explorer for: "${marker}" (logs can take up to a minute to appear).`)
  process.exit(0)
}

const search = `https://api.${settings.value.site}/api/v2/logs/events/search`
for (let attempt = 0; attempt < 24; attempt++) {
  await Bun.sleep(5_000)
  const response = await fetch(search, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "DD-API-KEY": process.env.DD_API_KEY ?? "",
      "DD-APPLICATION-KEY": appKey,
    },
    body: JSON.stringify({ filter: { query: `"${marker}"`, from: "now-15m", to: "now" }, page: { limit: 1 } }),
  })
  if (!response.ok) {
    console.error(`Logs search failed with HTTP ${response.status}.`)
    process.exit(1)
  }
  const result = (await response.json()) as { data?: Array<{ id: string; attributes?: { timestamp?: string } }> }
  const found = result.data?.[0]
  if (found) {
    console.log(`found through the Datadog Logs search: id=${found.id} timestamp=${found.attributes?.timestamp}`)
    process.exit(0)
  }
}
console.error("The record did not appear in the Logs search within 2 minutes.")
process.exit(1)
