export * as ConfigManaged from "./managed"

import os from "os"
import path from "path"
import { Config, Effect, HashSet, Option, Schema } from "effect"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"

const MANAGED_PLIST_DOMAIN = "ai.opencode.managed"

// Keys injected by macOS/MDM into the managed plist that are not OpenCode config
const PLIST_META = HashSet.make(
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
)

// A variable read from the live environment. An empty value counts as not set, as the former `||` reads did.
const envVar = (name: string) =>
  readEnvSnapshot(Config.option(Config.String(name))).pipe(Effect.map(Option.filter((value) => value !== "")))

const systemManagedConfigDir = Effect.fnUntraced(function* () {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(
        Option.getOrElse(yield* envVar("ProgramData"), () => "C:\\ProgramData"),
        "opencode",
      )
    default:
      return "/etc/opencode"
  }
})

/** The managed config directory. Tests move it with OPENCODE_TEST_MANAGED_CONFIG_DIR. */
export const managedConfigDir = Effect.fn("ConfigManaged.managedConfigDir")(function* () {
  const testDir = yield* envVar("OPENCODE_TEST_MANAGED_CONFIG_DIR")
  if (Option.isSome(testDir)) return testDir.value
  return yield* systemManagedConfigDir()
})

// plutil prints the plist dictionary as a JSON object.
const PlistJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

/** Converts plutil JSON output into config JSON text without the MDM metadata keys. */
export const parseManagedPlist = Effect.fn("ConfigManaged.parseManagedPlist")(function* (json: string) {
  const raw = yield* Schema.decodeEffect(PlistJson)(json)
  return yield* Schema.encodeEffect(PlistJson)(
    Object.fromEntries(Object.entries(raw).filter(([key]) => !HashSet.has(PLIST_META, key))),
  )
})

// Converts a plist to JSON with plutil. None when plutil cannot start, which counts as a failed
// conversion. The Config layer calls this without AppProcess, so it provides its own.
const convertPlist = (plist: string) =>
  AppProcess.Service.use((appProcess) =>
    appProcess.run(ChildProcess.make("plutil", ["-convert", "json", "-o", "-", plist], { stdin: "ignore" })),
  ).pipe(Effect.option, Effect.provide(LayerNode.compile(AppProcess.node)))

/** Reads the macOS managed preferences (.mobileconfig deployed via MDM). Other platforms have none. */
export const readManagedPreferences = Effect.fn("ConfigManaged.readManagedPreferences")(function* () {
  if (process.platform !== "darwin") return Option.none<{ source: string; text: string }>()
  const fs = yield* FSUtil.Service

  const user = yield* Effect.try(() => os.userInfo().username || "user").pipe(Effect.orElseSucceed(() => "user"))
  const paths = [
    path.join("/Library/Managed Preferences", user, `${MANAGED_PLIST_DOMAIN}.plist`),
    path.join("/Library/Managed Preferences", `${MANAGED_PLIST_DOMAIN}.plist`),
  ]

  for (const plist of paths) {
    if (!(yield* fs.existsSafe(plist))) continue
    const result = yield* convertPlist(plist)
    if (Option.isNone(result) || result.value.exitCode !== 0) continue
    return Option.some({
      source: `mobileconfig:${plist}`,
      // Output that does not parse was a defect before (a sync throw); keep it one.
      text: yield* parseManagedPlist(result.value.stdout.toString()).pipe(Effect.orDie),
    })
  }

  return Option.none<{ source: string; text: string }>()
})
