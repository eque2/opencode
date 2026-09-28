export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Effect, HashSet, Option, Schema } from "effect"
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

function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
    default:
      return "/etc/opencode"
  }
}

export function managedConfigDir() {
  return process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()
}

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

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const paths = [
    path.join("/Library/Managed Preferences", user, `${MANAGED_PLIST_DOMAIN}.plist`),
    path.join("/Library/Managed Preferences", `${MANAGED_PLIST_DOMAIN}.plist`),
  ]

  for (const plist of paths) {
    if (!existsSync(plist)) continue
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
