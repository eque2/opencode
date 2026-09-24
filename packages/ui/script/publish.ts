#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isPackageManifest, pack } from "./pack"

process.chdir(fileURLToPath(new URL("..", import.meta.url)))

const pkg: unknown = await Bun.file("package.json").json()
if (!isPackageManifest(pkg)) throw new Error("package.json must declare a name, a version, and an exports map")
const tarball = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`

if ((await $`npm view ${pkg.name}@${pkg.version} version`.nothrow()).exitCode === 0) {
  console.log(`already published ${pkg.name}@${pkg.version}`)
  process.exit(0)
}

try {
  await $`bun run typecheck`
  await $`bun run test`
  await pack()
  await $`npm publish ${tarball} --access public --tag ${Script.channel}`
} finally {
  await rm(tarball, { force: true })
}
