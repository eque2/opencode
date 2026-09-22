# Effect v4 update report

## Scope

- Branch: `effect-v4-update`
- Starting Effect line: `4.0.0-beta.83`
- Target Effect line: `4.0.0-rc.117` from the npm `rc` dist-tag
- TypeScript start: `5.8.2`
- TypeScript target: `5.9.3`
- Canonical lint bundle: v4, 54 rules, marker target `4.0.0-rc.112`

## Upstream provenance

- Migration guide cache refreshed: 2026-09-22T16:52:38Z
- Rename map base: `04f510659ed28bf8214c12e98565c48ab0ab8d7d`
- Rename map head: `31b3cdbf9f126294b1aa538efa1b1fbccb3cbd6f`
- The rename map changed during this run.
- The official `@effect/codemod` package has no v4 transform.

## Version decisions

- Pin all declared Effect v4 packages exactly to `4.0.0-rc.117` for reproducible CI.
- Update TypeScript to `5.9.3`, the newest GA version accepted by the current tooling.
- `opentui-spinner` requires TypeScript `^5` and prevents TypeScript 7.
- No declared Effect package requires consolidation into core `effect`.

## Baseline

- `npx tsc --noEmit`: failed with 17,431 errors across 1,190 files. The root command includes artifacts, generated environments, and packages outside the supported workspace gate.
- `npx --yes bun@1.3.14 run typecheck`: passed, 30 of 30 tasks.
- `GITHUB_ACTIONS=false npx --yes bun@1.3.14 turbo test`: failed at `@opencode-ai/app`.
- Existing test failure: `packages/app/src/i18n/desktop-native.test.ts` expected `pa` for `pa-PK` but received `en`.
- App result before the Turbo stop: 723 passed and 1 failed. Other completed package tests passed.

## Migration results

- A clean Bun 1.3.14 install resolves one Effect runtime: `effect@4.0.0-rc.117`.
- All supported workspace typechecks pass: 30 of 30 Turbo tasks with the cache disabled.
- The compiler trail moved from 17,431 errors in the unsupported root-wide baseline to 95 supported-workspace migration errors, briefly 97 after dependency resolution, then zero.
- The migration replaced retired Schema error classes, config constructors, filesystem glob helpers, retry schedule constructors, socket readers, Context reference access, and the OpenTelemetry tracer module.
- The migration updated the HTTP API generator, protocol constraints, SQLite bindings, SSE decoding, and OTLP exporter flushing for Effect 4.
- HTTP no-content request branches now reject explicit JSON `null` while they still accept a missing request body.
- Empty plan-tool parameters now remain a strict empty JSON object under Effect 4 Schema semantics.
- The v2 OpenAPI adapter preserves the public schema names and union order expected by the generated SDK.
- The v2 SDK regenerates without a working-tree diff.
- A retired-API scan reports no remaining uses of the targeted Effect 3 APIs.

## Semantic audits

- Layer audit: 130 matches in 60 files. The remaining uses preserve intentional memoization and scoping.
- Fiber audit: 117 matches in 64 files. The remaining fork and supervision behavior is intentional.
- Cause audit: 37 matches in 23 files. The remaining cause handling preserves typed failures and defects.
- Equality audit: one match in one file. Its behavior is intentional.
- Context reference sites were reviewed after the Effect 4 fiber-context migration.
- A Result-accessor codemod dry run covered 21 TypeScript projects and produced no edits.

## Lint integration

- The repository contains the canonical v4 `effect-rules.mjs` and `effect-eslint-config.mjs` files.
- The root lint command runs Oxlint, Effect ESLint, and the Effect language service.
- Effect ESLint currently gates `packages/protocol/src` and `packages/effect-sqlite-node/src`.
- The Effect language-service plugin is active in 21 package TypeScript configurations.
- `bun run lint` passes. Oxlint reports 4,865 legacy warnings and zero errors.
- Effect ESLint reports zero findings in the gated scope.
- The Effect language service reports zero findings across 26 checked files.
- A full-repository Effect ESLint audit found 30,809 legacy findings. The migration uses staged enforcement instead of hiding these findings.

## Verification

- Forced workspace typecheck: 30 passed, zero cached, zero failed.
- Focused provider, workspace, worktree, and tool regressions: 177 passed, zero failed, 16 snapshots passed.
- Core suite: 1,098 passed, zero failed, 3,010 expectations passed.
- Socket suite: 27 passed, zero failed, 105 expectations passed.
- Session HTTP suite: 21 passed, zero failed, 112 expectations passed.
- Tool parameter suite: 60 passed, zero failed, 16 snapshots passed.
- Complete OpenCode suite with Bun 1.3.14: 3,587 passed, 22 skipped, one todo, and one PTY timeout under full-suite load.
- The timed-out PTY test passed alone in 13.6 seconds with Bun 1.3.14.
- The generated SDK build completed and left no tracked diff.
- The CLI entry point completed `--version` and returned `local`.

## Known external conditions

- The app baseline still has one unrelated localization failure: `pa-PK` resolves to `en` instead of `pa`.
- The host exports `GOOGLE_CLOUD_LOCATION=us-central1`. Vertex tests pass when the host value is removed, as their fallback-variable cases require.
- Turbo can select Bun 1.2.15 from the ambient `PATH`. Authoritative migration checks use the pinned Bun 1.3.14 executable.

## Deferred decisions

- Expand the Effect lint gate only after each added package has a reviewed warning baseline.
- Resolve the existing app localization failure separately from the Effect migration.
- Consider increasing the full-suite PTY timeout or reducing suite contention; the isolated behavior is correct.
