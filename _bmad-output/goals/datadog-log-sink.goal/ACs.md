> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

# Acceptance criteria

Goal: the Datadog log sink in `packages/core/src/observability/datadog.ts` implements pattern 3 in full. That covers every plan Decision in `./plan.md` and every story criterion in `./spec/story.md`, with the design record in `specs/observability/logging-patterns.md` kept true.

All paths are relative to the worktree root, unless they start with `./`.

## Done when

- [ ] **CRITICAL** The repository quality gate in `package.json` passes end to end, shown by real run output: root `bun run lint` is clean, root `bun typecheck` is clean, `bun test` in `packages/core` has 0 failures, `bun run check:generated` in `packages/client` is clean, `bun run test:httpapi` in `packages/opencode` passes, `./packages/sdk/js/script/build.ts` leaves `git status` clean (or its regenerated output is committed), and `bunx prettier --check` on every changed file is clean.
      - explanation: stage 3 has not started; no implementation exists yet.
- [ ] **CRITICAL** AC-1: `packages/core/src/observability/datadog.ts` reads a global config file's `observability.datadog` object, and the env var overrides it. The AC-1 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` runs un-skipped and passes, with its `@ts-expect-error` lines removed.
      - explanation: red-phase scaffold only; `Datadog.provider` does not exist.
- [ ] AC-1b: `packages/core/src/observability.ts` passes `Global.Path.config` to `Datadog.provider`, so `Observability.layer` uses the file layer. A passing test titled `AC-1b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` proves it.
      - explanation: not written.
- [ ] AC-1c: in `packages/core/src/observability/datadog.ts`, files merge key by key with the later file winning. An empty file counts as none. A malformed JSONC file, or a non-object `observability` or `datadog`, is ignored with one warning while env settings still apply. Passing tests titled `AC-1c …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove each case.
      - explanation: not written.
- [ ] **CRITICAL** AC-1d: `packages/core/src/observability/datadog.ts` applies the file layer as narrow-only. A file cannot set `content: "full"`, cannot set `url`, cannot set an unknown `site`, and cannot re-include `question` or `pty`. Each attempt is ignored with one warning. Passing tests titled `AC-1d …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove each case.
      - explanation: not written.
- [ ] AC-1e: in `packages/core/src/observability/datadog.ts`, `level` is case-insensitive in env and file, `flushInterval` accepts a duration string, and an empty env value counts as unset. A bad value that turns the sink off emits one `Warn` to the other sinks. Passing tests titled `AC-1e …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove it.
      - explanation: not written.
- [ ] **CRITICAL** AC-2: `packages/core/src/observability/datadog.ts` ignores an `apiKey`, `api_key` or `DD_API_KEY` in a config file, and sends only the env key. The V1 config still loads through `packages/core/src/v1/config/config.ts`. The AC-2 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` runs un-skipped and passes.
      - explanation: red-phase scaffold only; `Datadog.provider` does not exist.
- [ ] AC-2b: `packages/core/src/observability/datadog.ts` writes one warning, naming the file, when a config file holds an API key. A passing test titled `AC-2b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` proves it.
      - explanation: not written.
- [ ] **CRITICAL** AC-3: `packages/core/src/observability/datadog.ts` ships content inside `Datadog.withPolicy({ content: "full" })` and redacts it outside, and secrets stay redacted inside the scope. The AC-3 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` runs un-skipped and passes.
      - explanation: red-phase scaffold only; `Datadog.withPolicy` does not exist.
- [ ] **CRITICAL** AC-3b: in `packages/core/src/observability/datadog.ts`, nested `withPolicy` scopes merge field by field with the inner value winning. A policy `categories` value cannot re-include `question` or `pty`. Passing tests titled `AC-3b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove it.
      - explanation: not written.
- [ ] AC-4: per-sink levels work in `packages/core/src/observability/logging.ts`. A `Debug` record reaches Datadog and not an `Info` file log, and an `Info` record reaches the file. The AC-4 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` passes un-skipped.
      - explanation: red-phase scaffold only; `fileLogger` has no level argument.
- [ ] AC-4b: `packages/core/src/observability.ts` sets the global minimum to the lowest active sink level. With Datadog off, it equals the file level exactly; a Datadog level above the file level leaves the file level in force; a Datadog level of `None` sends nothing; an invalid `OPENCODE_LOG_LEVEL` keeps `INFO`. The stderr and OTLP loggers filter to the file level. Passing tests titled `AC-4b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` cover each row.
      - explanation: not written.
- [ ] AC-5: in `packages/core/src/observability/datadog.ts`, a `429` with `Retry-After: 2` delays the next attempt by at least two seconds. The AC-5 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` passes un-skipped.
      - explanation: red-phase scaffold only; the probe measured a 506 ms gap.
- [ ] AC-5b: in `packages/core/src/observability/datadog.ts`, an HTTP-date `Retry-After` is honoured, a value of 45 is capped at 30, and `-1` falls back to the exponential backoff (these use `TestClock`). `400`, `401`, `403` and `413` drop the batch with no retry. Passing tests titled `AC-5b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove each case.
      - explanation: not written.
- [ ] AC-6: `packages/core/src/observability/datadog.ts` sends nothing after a batch exhausts its retries, until the cooldown ends. The next record after the cooldown is sent. The AC-6 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` passes un-skipped.
      - explanation: red-phase scaffold only; no circuit breaker or cooldown option exists.
- [ ] AC-6b: `packages/core/src/observability/datadog.ts`, with the default 60-second cooldown under `TestClock`, sends nothing at 59 seconds and sends again after 60 seconds. Each off period emits exactly one `Warn` record to the other sinks, and that record never appears in an intake body. The buffer holds at most 10,000 entries and drops the oldest first. Passing tests titled `AC-6b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove each case.
      - explanation: not written.
- [ ] AC-7: every request from `packages/core/src/observability/datadog.ts` is gzip-compressed with `Content-Encoding: gzip`, and `./STATE.md` records a citation of the Datadog Logs API documentation that confirms gzip support. The AC-7 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` passes un-skipped.
      - explanation: red-phase scaffold only; bodies are sent uncompressed.
- [ ] AC-7b: `packages/core/src/observability/datadog.ts` measures chunks in UTF-8 bytes. A multi-byte batch splits into chunks that are each under 4.5 MB when decompressed and each gzip-compressed. An entry above 1,000,000 bytes is truncated with `[TRUNCATED]`. Passing tests titled `AC-7b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove it.
      - explanation: not written.
- [ ] AC-8: disposing a runtime that holds `packages/core/src/observability/datadog.ts` flushes the buffered records. The AC-8 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` passes un-skipped.
      - explanation: the characterisation test passed in the probe but is still skipped.
- [ ] AC-8b: disposing a runtime built from `packages/core/src/observability.ts` flushes the Datadog buffer. Disposal against a `503` or `429` intake finishes within 5 seconds with one attempt and no `Retry-After` wait. Disposal while the breaker is open sends nothing. Passing tests titled `AC-8b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` prove each case.
      - explanation: not written.
- [ ] **CRITICAL** AC-9: `packages/core/src/observability/datadog.ts` scrubs known secret shapes from the message, attribute values at any depth, and error messages, including `exaApiKey` query parameters. The surrounding text survives, and ordinary words such as `task-…`, `monkey=` and `tokenizer` and the key `inputTokens` are not redacted. The AC-9 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` runs un-skipped and passes.
      - explanation: red-phase scaffold only; only Bearer tokens are scrubbed.
- [ ] **CRITICAL** AC-9b: `packages/core/src/observability/datadog.ts` scrubs secret shapes from `error.stack` and the pretty cause, in every content mode including `full`. A passing test titled `AC-9b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` proves it.
      - explanation: not written.
- [ ] **CRITICAL** AC-10: by default, `packages/core/src/observability/datadog.ts` sends no answer text for a record shaped like today's `Question.reply` log with no category, and excludes the `question.*` and `pty.*` categories. The AC-10 leaf in `packages/core/test/effect/observability-datadog-atdd.test.ts` runs un-skipped and passes.
      - explanation: red-phase scaffold only; the default filter is `*` and `answers` is not a content key.
- [ ] **CRITICAL** AC-10b: with no category, `packages/core/src/observability/datadog.ts` sends no `cmd` or `data` text for records shaped like today's `Pty.create` and `Pty.write` logs. A passing test titled `AC-10b …` in `packages/core/test/effect/observability-datadog-atdd.test.ts` proves it.
      - explanation: not written.
- [ ] `packages/core/src/observability/datadog.ts` carries a `ponytail:` comment that records the no-disk-spool ceiling and its upgrade path, as the plan's "no disk spool" Decision requires.
      - explanation: the comment is not updated yet.
- [ ] AC-11: `packages/web/src/content/docs/cli.mdx` lists every Datadog switch with its default and the narrow-only file rules. `specs/observability/logging-patterns.md` §Datadog sink switches and §Limits of the current sink match the shipped behaviour, including the duplicate listener note and the global-files-only scope.
      - explanation: documentation is not updated yet.
- [ ] The binding verdict is recorded in `./STATE.md`. It is grounded in one live run: opencode with a real `DD_API_KEY` sends a record through `packages/core/src/observability/datadog.ts` to the real Datadog intake, and the record is found through the Datadog Logs search, with its id quoted.
      - explanation: needs a real Datadog API key from the owner; the run has not happened.

## Notes

- **Story ids.** AC-1 to AC-11 match `./spec/story.md` and the leaf titles in the ATDD test file. An `AC-nb`, `AC-nc`, … criterion is a secondary branch. Stage 3 writes it as an ordinary test whose title starts with that id.
- **Bun version.** This environment has Bun 1.2.15, and the repository asks for 1.3.14. Run the gate on 1.3.14 where possible, and record the version used in the evidence.
