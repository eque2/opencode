# Instance Context

Instance selection is now Effect-provided context.

Use these APIs:

- `InstanceRef` for the current project context, as an `Option<InstanceContext>`.
- `WorkspaceRef` for the current workspace id, as an `Option<WorkspaceV2.ID>`.
- `InstanceState.context` / `InstanceState.directory` inside Effect services that require an instance.
- `InstanceStore` at entry boundaries that need to load, reload, or dispose project contexts.
- `EffectBridge` for native, plugin, or plain JavaScript callback boundaries that need to re-enter Effect with captured refs.

Both refs default to `Option.none()`. Provide them with `Effect.provideService(InstanceRef, Option.some(ctx))`. Unwrap them with `Option` combinators, and use `Option.getOrUndefined` only at an external boundary.

Do not add new ambient instance globals. Promise and callback boundaries should either stay in Effect, use `EffectBridge`, or pass the required context explicitly.
