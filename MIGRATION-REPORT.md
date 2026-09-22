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

Pending.

## Lint integration

Pending.

## Deferred decisions

None currently.
