export * as ConfigPluginV1 from "./plugin"

import { Schema } from "effect"

// Plugin options pass unchecked to the plugin, which receives them as @opencode-ai/plugin
// PluginOptions (Record<string, unknown>; Readonly<Record<string, any>> in v2). The TUI
// plugin specs and loader type them the same way. The V2 config reuses this schema.
// eslint-disable-next-line effect/no-schema-any-unknown -- (a) plugins get these options unchecked as @opencode-ai/plugin PluginOptions, Record<string, unknown> (v2: Readonly<Record<string, any>>)
export const Options = Schema.Record(Schema.String, Schema.Unknown)
export type Options = Schema.Schema.Type<typeof Options>

export const Spec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, Options]))])
export type Spec = Schema.Schema.Type<typeof Spec>
