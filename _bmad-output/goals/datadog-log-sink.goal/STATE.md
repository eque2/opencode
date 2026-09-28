# State — datadog-log-sink

- **Stage:** 3 (pursue-goal) ran on 2026-09-28. `dev` was merged on 2026-09-28 (`a04610c20f`).
- **Worktree:** `opencode/.claude/worktrees/datadog-log-sink`, branch `datadog-log-sink`.
- **Criteria:** 27 total (10 critical). 27 of 27 met with evidence, including all 10 critical criteria. See [`./ACs.md`](./ACs.md).
- **Tests:** every ATDD leaf is un-skipped. `test/effect/observability-datadog*.test.ts` has 44 tests, and `bun test` in packages/core passes 1158 of 1158. The quality gate ran on Bun 1.3.14.
- **Binding verdict: PASS.** On 2026-09-28 the owner ran `bun _bmad-output/goals/datadog-log-sink.goal/live-check.ts` from the worktree root. The real `DD_API_KEY` and `DD_ENV=dev` came from the gitignored `.env.local`. One record went through `packages/core/src/observability/datadog.ts` to the real Datadog intake, and the owner found it through the Datadog Logs search:
  - Datadog log id: `AwAAAaDoWmifhtZeagAAABhBYURvV21raEFBQ1JHRjN4N2h5eGV3QUEAAAAkZjFhMGU4NWEtNjg5Zi00ZDQwLTg0YzMtOGY3ZDQwNTRlYjNjAAAAAA`
  - message: `opencode-live-check-e4f42551-f925-422e-b803-a75122ea3d1a`
  - timestamp `2026-09-28T14:10:34.271Z`, service `opencode`, source `opencode`, status `info`
  - tags `env:dev` and `version:local`; attributes `category: cli.live-check` and `run: 19544457`

  The record shows that the intake accepted the gzip body and the key header, and that the env tag, the category and the run ID string arrived as sent.
- **Datadog gzip citation (AC-7):** the Datadog Logs API reference, "Send logs" (`POST /api/v2/logs`, operation `SubmitLog`), at <https://docs.datadoghq.com/api/latest/logs/#send-logs>. The same text is in the published OpenAPI source, `DataDog/datadog-api-client-typescript` `.generator/schemas/v2/openapi.yaml`, read on 2026-09-28: "Datadog recommends sending your logs compressed. Add the `Content-Encoding: gzip` header to the request when sending compressed logs." The same description gives the limits that the sink uses: "Maximum content size per payload (uncompressed): 5MB", "Maximum size for a single log: 1MB", and "Maximum array size if sending multiple logs in an array: 1000 entries". It also lists the statuses 202, 400, 401, 403, 408, 413, 429, 500 and 503.
- **Decisions made in stage 3:**
  - The breaker record is a `Warn`, as the story and ACs say. The plan text says `logDebug`.
  - The `observability.datadog` schema uses plain strings, because a decode failure in `ConfigV1.Info` drops the whole config file. The sink checks the values itself.
  - The sink parses config files with `Bun.JSONC`, not `jsonc-parser`. The UMD entry of `jsonc-parser` broke the Node bundle in `test/npm.test.ts`.
  - The committed SDK v2 types had drifted from the API before this goal. Commit `8e7d1e85fa` regenerates them on their own, before the Datadog schema commit.
  - Own-judgment fix `d96d30d9ca`: the `run` field carried the `runID` Effect in place of the run ID string.
