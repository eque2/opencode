# Effect v4 update report

# Part 2: rc.117 to 4.0.3 (GA)

## Scope

- Branch: `worktree-effect-v4-ga`, from `origin/dev` at `861b210b77`
- Starting Effect line: `4.0.0-rc.117`
- Target Effect line: `4.0.3`, the npm `latest` dist-tag on 2026-10-12
- TypeScript: stays at `5.9.3`; `opentui-spinner` requires `^5`, so TypeScript 7 stays blocked
- Canonical lint bundle: v4, 54 rules, marker target `4.0.0`; the repository copy now matches it byte for byte
- Route: migrate the fork in place. Upstream `anomalyco/opencode` made the same move in PR #50231 (rc.118) and PR #54198 (4.0.1); this branch uses them as a reference only.

## Upstream provenance

- Migration guide cache refreshed: 2026-10-12T10:13:22Z; the rename map changed since the previous sync.
- The fresh map and the 4.0.3 export map agree: every `effect/unstable/<module>` path became `effect/<module>`, and `httpapi` also became `http-api`.
- The `imports` verb returns an empty join when the target repository sits under `.claude/worktrees/`; the rewrite used the 4.0.3 export map instead.

## Version decisions

- Pin `effect`, `@effect/opentelemetry`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/sql-sqlite-bun` exactly to `4.0.3`. The repository imports 18 `@stability unstable` modules (`effect/http`, `effect/http-api`, `effect/sql`, `effect/process`, `effect/socket`, ...), which may break in a minor release, so an exact pin is the safe range.
- Leave `@effect/language-service` at `0.87.2`; it never joined the unified version line.
- No package needed consolidation, and no `overrides` or `resolutions` block pinned Effect.

## Lint gate

- Oxlint now fails on warnings (`--deny-warnings`). Effect ESLint already used `--max-warnings=0`, and the language service already ran `--strict`.
- Oxlint no longer scans `.agents/skills/` and `.claude/skills/`. These folders hold skill bundles that bmad-method and eque2-code install, and they produced 3,158 of the 3,169 baseline warnings. The eque2-code anti-tamper policy forbids editing them here.
- The repository copy of `effect-rules.mjs` is synced with the canonical 4.0.0 bundle (message text only).
- The 11 repository warnings and 5 ESLint errors were fixed in the code. No rule, severity, or scope changed, and no inline disable was added. The `.opencode` TUI plugin warnings came from unresolved `@opentui` imports; the root now declares the three `@opentui` packages at their catalog version.

## Baseline (rc.117, before any change)

- `bun turbo typecheck --force`: passed, 30 of 30 tasks (`tsgo`).
- `bun run lint`: failed. Oxlint 3,169 warnings and 0 errors (3,158 in the vendored skill bundles), Effect ESLint 5 errors, language service 0 findings in 18 projects.
- Tests, per package (`bun run test`): 8 failures before any change.
  - `codemode`: 1 (`signature.test.ts`, an Infinity/NaN enum render; also fails on rc.117).
  - `llm`: 2 (`tool-runtime` "derives typed output schemas", Bedrock "drives a tool loop"; both expect `additionalProperties: false`).
  - `opencode`: 5 (the Google Vertex endpoint tests; the host exports `GOOGLE_CLOUD_LOCATION`, see Part 1).
  - `client`, `core`, `effect-drizzle-sqlite`, `http-recorder`, `httpapi-codegen`, `sdk-next`, `tui`, `session-ui`, `ui`: 0.
  - `opencode`: 3,590 pass, 22 skip, 1 todo, 5 fail.

## Migration results

- Dependencies: one `effect` copy (4.0.3) in `node_modules`. `bun.lock` kept rc.117 for the optional `effect` peer of `@standard-community/standard-json` and `standard-openapi`; those stale entries were removed.
- Fork patches: neither is in 4.0.3, and upstream carries neither. The SSE identifier patch moved to `dist/http-api` unchanged. The Bun upgrade-rejection patch now also respects `socket.destroyed`, which 4.0.3 added to that branch.
- Imports: 361 `effect/unstable/*` specifiers in 270 files moved to `effect/<module>`; `httpapi` became `http-api`; `Arbitrary` now comes from the `effect` barrel.
- Compiler trail after the bump: 57 unique errors in 7 packages, then 0. Root causes:
  - `Schema.isStartsWith` became `Schema.isStartingWith` (16 sites).
  - The barrel `Encoding` module became `effect/encoding` `Base64`, `Base64Url`, and `Hex` (6 files; wire-identical).
  - `Crypto.randomUUIDv4` became a method (5 sites; same UUID format).
  - `Effect.partition` and `Record.partition` now return `[passes, fails]` (2 sites; no other call exists).
  - `Scope.close` now needs a `Scope.Closeable` (type only).
- Runtime changes the compiler did not catch, all fixed:
  - Schema `make` is now a prototype getter that caches as a non-configurable own property. `Object.assign(schema, { make })` threw at module load in `@opencode-ai/llm`; `withStatics` now defines the properties, and `SessionsCursor` builds its constructor with `SchemaParser.make`.
  - `Schema.isInt` now exports a safe-integer range, so a caller's bound moved into `allOf`. Provider tool schemas (opencode, core, llm) and the published `config.json`/`tui.json` are restored to the rc.117 shape byte for byte.
  - `Schema.isPattern` exports a JSON Schema `pattern` only for a RegExp with the `u` flag. Every `isPattern` in the source now has it.
  - The public OpenAPI document renamed four error components to `<name>Encoded_1` and turned `SessionDurableEvent` into `anyOf`. The adapter now restores the rc.117 names, the legacy 400 mapping, and `oneOf`. The remaining differences from rc.117 are Effect's safe-integer bounds, one new description, and the SSE failure event name (see Deferred decisions).
- Generated client: `bun run --cwd packages/client generate` leaves no diff.

## Semantic audits

Four hazard lenses, an API-difference audit of every release from rc.118 to 4.0.3, and two adversarial reviews ran against the branch.

- Layer memoization: since rc.118 `HttpRouter.serve` builds in a forked memo map. Fourteen server tests merged their services beside the routes and shared them only by build timing; a probe with a 200 ms delay built two in-memory databases and returned 404. They now build their services beneath the routes. Production compositions already did.
- Equality: the prompt timer set and the Datadog sink registry now key by reference (`Equal.byReferenceUnsafe`), so a false "by identity" comment is now true.
- Fiber keep-alive and cause flattening: no change needed (33 and 214 sites reviewed).
- CLI subprocess tests (`opencode run`, `acp`): they fail only under heavy machine load. The rc.117 main checkout failed the same tests side by side under the same load, and both pass at low load.

## Verification (4.0.3)

- `bun turbo typecheck --force`: passed, 30 of 30 tasks, none cached.
- Oxlint `--deny-warnings`: 0 warnings, 0 errors (3,328 files). Effect ESLint: 0 problems (2,106 files). Language service `--strict`: 0 errors, 0 warnings, 0 messages in all 18 projects (2,821 files).
- Real entry points: `opencode serve` answers `/config` and `/doc` with 200 and exits within 1 s on SIGTERM (code 143) and on SIGINT (code 130); the rc.117 main checkout gives the same codes and timing for both signals. The TUI starts, draws its home screen, and exits 0 on Ctrl+C. `opencode run` with an unknown model exits 1 in 5 s, as on rc.117.
- Tests, per package, against the baseline: the same 8 failures and no new ones.
  - `codemode` 262 pass / 1 fail, `llm` 306 pass / 2 fail (8 new tests), `opencode` 3,589 pass / 7 fail; every other package 0 failures.
  - Two of the 7 `opencode` failures timed out during the full run ("concurrent loop callers all receive same error result", and the unknown-model `opencode run` case with its 15 s limit). Both pass when rerun: the first 3 of 3 times alone and 58 of 58 in its file, the second 3 of 3.
  - The 5 remaining `opencode` failures are the baseline Google Vertex tests.
- Merged `dev` (merge commit `8a08694e13`, which adds 168 documentation and JSON Schema files outside `packages/`): `bun install --frozen-lockfile` changes nothing; typecheck 30 of 30; oxlint 0 warnings and 0 errors; Effect ESLint 0 problems; language service 0 findings in 18 projects; `opencode serve` exits with 143 after SIGTERM and 130 after SIGINT, both within 1 s.
- Merged `dev` tests: the same 8 baseline failures plus one failure in the full run, "provider HttpApi > keeps provider.models hook input mutations out of provider state" (GET /provider returned 404). It passed 5 of 5 times alone, and the whole `test/server` folder passed (299 pass, 0 fail), so it is intermittent under full-suite load.
- Flake investigation: the 404 did not recur in about 30 targeted runs (up to 8 concurrent copies of the file), in 6 concurrent `test/server` runs, or in 2 full suites, on merged `dev`. A throwaway rc.117 checkout ran the same loads side by side. Both versions fail the same load-sensitive tests: "serves OAuth authorize response shapes" timed out in 6 of 6 merged runs and 5 of 6 rc.117 runs. In the parallel full suites, 3 tests failed only on merged `dev` and 2 only on rc.117; the 3 pass on merged `dev` when rerun. No migration defect was found.
- Root cause of the 404: Effect's `NodeHttpServer.layerTest` (the same in rc.117 and 4.0.3) listens on the wildcard address, and its client sends requests to `127.0.0.1`. On macOS, another process can bind `127.0.0.1` on the same ephemeral port and receive those requests; a probe showed `GET /provider` answered 404 by the other process. The server test layer now binds `127.0.0.1` itself (`f27ce6b22b`), so the second bind fails with `EADDRINUSE`; `test/server` passes (299 pass, 0 fail).
- Final `dev` (`2734d1f464`), full `opencode` suite: 3,590 pass, 22 skip, 6 fail. That is the 5 baseline Google Vertex failures plus "v2 pty HttpApi > serves location-wrapped PTY routes and retains exited sessions", whose poll ran out while `sh -c "exit 4"` still showed `running`. That test failed on rc.117 in 2 of 6 loaded runs and passes 3 of 3 times alone; it is a timing flake that predates the migration.

## Deferred decisions

- SSE wire name: Effect renamed the reserved stream-failure event from `effect/httpapi/stream/failure` to `effect/http-api/stream/failure`. In-repo clients read it from the spec, but a client and a server on different Effect lines (for example `opencode attach` across versions) will not recognise each other's typed stream failure. Note it in the release notes.
- `packages/sdk/openapi.json` was last regenerated on 2026-09-02 and was already stale on `dev`; it still names the old event. Regenerating it (`bun run script/generate.ts`) also picks up unrelated fork changes, so it is left for a separate commit.
- Safe-integer bounds in the public OpenAPI document (432 nodes) are Effect's own output and change no generated type. They stay.
- No lint rule guards a future `isPattern` without the `u` flag; oxlint has no `require-unicode-regexp`. A schema-output test would catch it.
- The upstream sync (about 4,500 upstream commits) remains a separate task.
- The merged branches `effect-v4-update` and `effect-v4-lint` can be deleted.

# Part 1: beta.83 to rc.117

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
