import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { pathToFileURL } from "url"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/plugin/shared"
import path from "path"

export type Scope = "global" | "local"

// Origin keeps the original config provenance attached to a spec.
// After multiple config files are merged, callers still need to know which file declared the plugin
// and whether it should behave like a global or project-local plugin.
export type Origin = {
  spec: ConfigPluginV1.Spec
  source: string
  scope: Scope
}

export const load = Effect.fn("ConfigPlugin.load")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  const items = yield* fs.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })
  return items.map((item): ConfigPluginV1.Spec => pathToFileURL(item).href)
})

export function pluginSpecifier(plugin: ConfigPluginV1.Spec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

export function pluginOptions(plugin: ConfigPluginV1.Spec): ConfigPluginV1.Options | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

// Path-like specs are resolved relative to the config file that declared them so merges later on do not
// accidentally reinterpret `./plugin.ts` relative to some other directory.
export const resolvePluginSpec = Effect.fn("ConfigPlugin.resolvePluginSpec")(function* (
  plugin: ConfigPluginV1.Spec,
  configFilepath: string,
) {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  // A target that does not resolve keeps the file URL.
  const resolved = yield* Effect.tryPromise(() => resolvePathPluginTarget(file)).pipe(Effect.orElseSucceed(() => file))

  const next: ConfigPluginV1.Spec = Array.isArray(plugin) ? [resolved, plugin[1]] : resolved
  return next
})

// Dedupe on the load identity (package name for npm specs, exact file URL for local specs), but keep the
// full Origin so downstream code still knows which config file won and where follow-up writes should go.
export function deduplicatePluginOrigins(plugins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const plugin of plugins.toReversed()) {
    const spec = pluginSpecifier(plugin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(plugin)
  }

  return list.toReversed()
}

export * as ConfigPlugin from "./plugin"
