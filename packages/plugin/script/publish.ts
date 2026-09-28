#!/usr/bin/env bun
import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { Schema } from "effect"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  exports: Schema.Record(Schema.String, Schema.String),
})

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

await $`bun tsc`
const originalText = await Bun.file("package.json").text()
const pkg: unknown = JSON.parse(originalText)
Schema.asserts(PackageJson, pkg)
if (await published(pkg.name, pkg.version)) {
  console.log(`already published ${pkg.name}@${pkg.version}`)
} else {
  const exports = Object.fromEntries(
    Object.entries(pkg.exports).map(([key, value]) => {
      const file = value.replace("./src/", "./dist/").replace(".ts", "")
      return [
        key,
        {
          import: file + ".js",
          types: file + ".d.ts",
        },
      ]
    }),
  )
  await Bun.write("package.json", JSON.stringify({ ...pkg, exports }, null, 2))
  try {
    await $`bun pm pack`
    await $`npm publish *.tgz --tag ${Script.channel} --access public`
  } finally {
    await Bun.write("package.json", originalText)
  }
}
