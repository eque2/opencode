#!/usr/bin/env bun

import { $ } from "bun"
import { rm } from "node:fs/promises"
import path from "node:path"

type PackageManifest = Record<string, unknown> & {
  name: string
  version: string
  exports: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    isRecord(value) && typeof value.name === "string" && typeof value.version === "string" && isRecord(value.exports)
  )
}

export async function pack() {
  const original = await Bun.file("package.json").text()
  const pkg: unknown = JSON.parse(original)
  if (!isPackageManifest(pkg)) throw new Error("package.json must declare a name, a version, and an exports map")
  const tarball = path.resolve(`${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`)

  await $`bun run build`
  pkg.exports = Object.fromEntries(
    Object.entries(pkg.exports).map(([key, value]) => {
      if (typeof value !== "string" || (!value.endsWith(".ts") && !value.endsWith(".tsx"))) return [key, value]
      return [
        key,
        {
          types: value.replace("./src/", "./dist/").replace(/\.tsx?$/, ".d.ts"),
          import: value,
        },
      ]
    }),
  )

  await rm(tarball, { force: true })
  await Bun.write("package.json", JSON.stringify(pkg, null, 2) + "\n")
  try {
    await $`bun pm pack`
    return tarball
  } finally {
    await Bun.write("package.json", original)
  }
}

if (import.meta.main) console.log(await pack())
