---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-09-28'
storyId: 'datadog-log-sink'
storyKey: 'datadog-log-sink'
storyFile: './story.md'
atddChecklistPath: './atdd-checklist-datadog-log-sink.md'
generatedTestFiles: ['packages/core/test/effect/observability-datadog-atdd.test.ts']
inputDocuments: ['./story.md', '../plan.md', 'specs/observability/logging-patterns.md', 'specs/observability/logging-sites.md', 'packages/core/test/effect/observability-datadog.test.ts']
acceptanceCriteria:
  - { id: AC-1, idSource: supplied, text: 'A global config file value configures the sink; the env var overrides it' }
  - { id: AC-2, idSource: supplied, text: 'A config-file apiKey never enables the sink; the V1 schema rejects it' }
  - { id: AC-3, idSource: supplied, text: 'LogPolicy content full ships content inside its scope only' }
  - { id: AC-4, idSource: supplied, text: 'A Debug record reaches Datadog but not an Info file log' }
  - { id: AC-5, idSource: supplied, text: '429 with Retry-After 1 delays the next attempt by at least one second' }
  - { id: AC-6, idSource: supplied, text: 'After retries fail, no request for 60 seconds' }
  - { id: AC-7, idSource: supplied, text: 'Every request is gzip-compressed' }
  - { id: AC-8, idSource: supplied, text: 'Disposing the runtime flushes buffered records' }
  - { id: AC-9, idSource: supplied, text: 'Secret shapes in string values never reach the intake' }
  - { id: AC-10, idSource: supplied, text: 'question and pty records are excluded by default' }
  - { id: AC-11, idSource: supplied, text: 'Operator docs and specs match shipped behaviour (documentation only)' }
---

# ATDD checklist: datadog-log-sink

## Step 1: Preflight and context

- **Detected stack.** `backend`. The package under test is `packages/core`, a Bun and TypeScript library with no browser surface. The monorepo also holds front-end packages, but no criterion touches them.
- **Framework.** `bun:test`, with preload `packages/core/test/preload.ts` (from `packages/core/bunfig.toml`). The existing patterns come from `packages/core/test/effect/observability-datadog.test.ts`: a `Bun.serve` local intake and `ConfigProvider.fromEnv`.
- **Story.** `./story.md`, with AC-1 to AC-11 supplied.
- **Knowledge fragments.** The core set is `data-factories.md`, `component-tdd.md`, `test-quality.md` and `test-healing-patterns.md`. The backend set is `test-levels-framework.md`, `test-priorities-matrix.md` and `ci-burn-in.md`. No Playwright, Pact or MCP branch opens: there is no browser surface, no Pact artefacts, and no contract request.

## Step 2: Generation mode

- **Mode.** AI generation. The step rule says to always use AI generation for a backend stack, so no recording is needed.

## Step 3: Test strategy

| AC | Level | Priority | First assertion that must fail | Secondary branches (green phase) |
| --- | --- | --- | --- | --- |
| AC-1 | Integration: temp config dir and `ConfigProvider` | P1 | `fromFile.categories` is `"llm"` | `config.json` and `opencode.jsonc` merge order; malformed JSONC turns the sink off |
| AC-2 | Integration and unit (schema) | P0 (security) | `resolved` is `undefined` | Schema rejection message; an env key plus a file key still uses only the env key |
| AC-3 | Integration: local intake | P1 | `scoped.prompt` is `"visible prompt"` | `categories` override in `LogPolicy`; nested scopes |
| AC-4 | Integration: file logger and intake | P1 | the file text lacks `"debug only"` | the stderr and OTLP wrappers filter; `Observability.layer` computes the lowest level |
| AC-5 | Integration: intake with a queued 429 | P1 | the gap between attempts is ≥ 950 ms | `Retry-After` above 30 is capped; an HTTP-date form |
| AC-6 | Integration: intake always 503 | P1 | the request count is unchanged after the second record | recovery after 60 s (use `TestClock` in green); one `logDebug` emitted |
| AC-7 | Integration: intake | P2 | `encoding` is `"gzip"` | chunk limit on the uncompressed size |
| AC-8 | Integration: `ManagedRuntime` | P1 | messages equal `["last words"]` | the `Observability.layer` runtime disposal path |
| AC-9 | Integration: intake | P0 (security) | no secret literal remains in the payload | `ghs_`, `xoxp-`, `access_token=`; no over-redaction of ordinary words |
| AC-10 | Unit: `categoryFilter` on default settings | P0 (DLP) | `question.asked` and `pty.write` are excluded | an explicit `*` opts back in |
| AC-11 | None (documentation) | P2 | n/a | reviewed in `ACs.md` |

## Step 4: Generated tests (sequential mode)

- **Execution mode.** Sequential. The API and E2E subagent workers target Playwright and HTTP API specs. This story is backend library behaviour, so one worker wrote one file.
- **File.** `packages/core/test/effect/observability-datadog-atdd.test.ts`.
- **Leaves.** It has exactly one `test.skip()` leaf per AC, from AC-1 to AC-10, and each title holds one `AC-n` token. AC-11 has no test, because it is documentation only.
- **Types.** A reference to an API that does not exist yet carries `@ts-expect-error`. This keeps `bun typecheck` green in the red phase. The directive becomes an error once the API lands, which forces its removal when the test is un-skipped.

## Step 4c: Red-phase compliance

- **`test.skip()` on every leaf.** Yes, 10 of 10. The suite run shows `10 skip, 0 fail`.
- **Red proof.** An un-skipped copy was run once on 2026-09-28 and then deleted. The result was 9 fail and 1 pass:
  - AC-1, AC-2, AC-3, AC-4, AC-5 (gap 506 ms), AC-6, AC-7, AC-9 and AC-10 fail.
  - **AC-8 passes already.** `Logger.batched` flushes when the scope closes. AC-8 is therefore a characterisation test that guards the behaviour stage 3 must keep. It is not a red scaffold. This is an accepted deviation from the red-phase rule, because the plan's "flush on shutdown" Decision asks for proof, not for new behaviour.
- **Fixtures.** No new fixtures. Each test creates its own temp dir and `Bun.serve` intake, and disposes them with `await using`.
- **Secret fixtures** are built at runtime, so `gitleaks` does not flag them.

## Phase R update (2026-09-28)

The secondary branches in the Step 3 table are superseded by the gated `AC-nb` criteria in `../ACs.md`, which the review sharpened. The leaves for AC-2, AC-3, AC-4, AC-5, AC-6, AC-9 and AC-10 were rewritten, as listed in `../reviews/2026-09-28-phase-r.md`. The red probe was re-run: 9 fail, and 1 characterisation pass (AC-8).

## Step 5: Implementation checklist (green phase)

For each AC, in the order of the plan's Decisions:

1. Remove `test.skip` from the leaf, and remove its `@ts-expect-error` lines.
2. Implement until the leaf passes.
3. Add the `AC-nb` tests listed in `../ACs.md` as ordinary tests, each titled with its id.
4. Run `bun test test/effect/observability-datadog*.test.ts` and `bun typecheck` in `packages/core`.

The whole story is done when all leaves pass un-skipped and the gate in `../ACs.md` passes.
