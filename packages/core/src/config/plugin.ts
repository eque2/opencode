export * as ConfigPlugin from "./plugin"

import { Schema } from "effect"
import { ConfigPluginV1 } from "../v1/config/plugin"

export class Entry extends Schema.Class<Entry>("ConfigV2.Plugin.Entry")({
  package: Schema.String,
  options: ConfigPluginV1.Options.pipe(Schema.optional),
}) {}

export const Plugin = Schema.Union([Schema.String, Entry])
export type Plugin = typeof Plugin.Type

export const Plugins = Plugin.pipe(Schema.Array)
