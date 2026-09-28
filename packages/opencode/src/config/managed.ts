export * as ConfigManaged from "./managed"

import os from "os"
import path from "path"
import { Config, Effect, HashSet, Option, Schema } from "effect"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Process } from "@/util/process"

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
    const result = yield* Effect.promise(() =>
      Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true }),
    )
    if (result.code !== 0) continue
    return Option.some({
      source: `mobileconfig:${plist}`,
      // Output that does not parse was a defect before (a sync throw); keep it one.
      text: yield* parseManagedPlist(result.stdout.toString()).pipe(Effect.orDie),
    })
  }

  return Option.none<{ source: string; text: string }>()
})
