import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ConfigProvider, Effect, Layer, Scope } from "effect"

/**
 * Scoped override for the `OPENCODE_WORKSPACE_ID` flag. The server reads the flag through
 * `FlagConfig` from the ambient ConfigProvider, so this puts a provider with the fixed id in
 * front of the current one for the rest of the surrounding scope. Every other key still
 * resolves through the previous provider, and the scope close restores it regardless of the
 * test outcome. Fibers forked after the call (a served router, for example) inherit it.
 */
export function withFixedWorkspaceID(id: WorkspaceV2.ID): Effect.Effect<void, never, Scope.Scope> {
  return Effect.updateServiceScoped(ConfigProvider.ConfigProvider, (current) =>
    ConfigProvider.orElse(ConfigProvider.fromUnknown({ OPENCODE_WORKSPACE_ID: id }), current),
  )
}

/**
 * Layer form of `withFixedWorkspaceID` for a server built in a test layer: provide it to the
 * served routes so every request reads the fixed id, with the ambient provider as fallback.
 */
export function fixedWorkspaceIDLayer(id: WorkspaceV2.ID): Layer.Layer<never> {
  return ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ OPENCODE_WORKSPACE_ID: id }), { asPrimary: true })
}
