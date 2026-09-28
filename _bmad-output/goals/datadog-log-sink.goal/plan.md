# Plan: develop approach 3, the batched custom Logger sink for Datadog

This plan takes pattern 3 from a working first version to a production-ready transport and policy gate. Pattern 3 is the "batched custom Logger sink" in the observability specs.

## Source documents

Stage 2 and stage 3 must read these documents. Every Decision below cites them.

| Document | Path (from the workspace root) | What this plan uses |
| --- | --- | --- |
| Patterns | `opencode/specs/observability/logging-patterns.md` | §Pattern 3 (design, pros and cons), §Recommended combination, §Configuration layers, §Datadog sink switches, §Limits of the current sink |
| Sites | `opencode/specs/observability/logging-sites.md` | §How to read the tables (category taxonomy, sensitivity tags), §Existing infrastructure (mount points), §Gaps to close first (item 4: logs that already carry content) |
| Brief | `opencode/events.md` | The original requirement: "highly configurable with different layers of configuration switches" |

## Current state

Commits `8cceaae097`, `98bab76a90` and `607813c1c3` on branch `effect-v4-update` already contain the first version of the sink:

- `opencode/packages/core/src/observability/datadog.ts` holds the sink.
- `opencode/packages/core/src/observability.ts` mounts it.
- `opencode/packages/core/test/effect/observability-datadog.test.ts` holds three tests, which pass.

The first version covers config layers 1, 3 and 4 in §Configuration layers. It also covers category filtering, key-based redaction, trace correlation and batching.

This plan closes the rest of pattern 3:

- the items in §Limits of the current sink;
- config layers 2 and 5;
- the content leaks listed in sites §Gaps item 4.

## Out of scope

The emission patterns 1, 2, 4, 5 and 6 in §Recommended combination are separate workstreams. They decide which records are produced. This plan decides only what the sink does with a record. Each emission pattern deserves its own goal after this one.

## Configuration

### Decision: the config-file layer (layer 2)

**Choice** — Add an optional `observability.datadog` object to the V1 config schema. Read it only from the global config files in `Global.Path.config`. The file layer may only narrow the process settings: it can never set `content: "full"`, never re-include `question` or `pty`, never set `url`, and it may set `site` only to a known Datadog site. Precedence is env, then file, then code default.

**Workflow** — `bmad-testarch-atdd` in stage 2 writes the failing precedence and narrowing tests. Then `bmad-build` in stage 3.

**Justification** — The brief asks for "different layers of configuration switches". §Configuration layers names layer 2 as the only file-level layer, and it is not built. The sink is built once per process, before any project config loads, so only process-level files can configure it. The user chose global files only on 2026-09-28. A file can be written by the config HTTP API, a tool or a plugin, so it must not widen exposure or redirect the API key. The user chose narrow-only on 2026-09-28.

**Alternatives**
- Environment only. Rejected: it does not meet the brief's layered requirement.
- A separate `datadog.json` file. Rejected: it is a second config discovery path to maintain.
- Project files as a per-instance `LogPolicy`. Rejected by the user: a committed project file would then control what that project sends.
- Managed config. Rejected for now: its resolver lives in `packages/opencode`, which `core` must not import.
- Full file control. Rejected by the user: it re-opens the data-loss-prevention risks that the review found.

### Decision: keep the API key out of config files

**Choice** — Read `DD_API_KEY` from the environment only. An `apiKey` key (or `api_key`, or `DD_API_KEY`) under `observability.datadog` in a config file is ignored, and the sink writes one warning to the other sinks that names the file. The rest of the config still loads.

**Workflow** — `bmad-build` in stage 3. The same ATDD suite covers it.

**Justification** — Config files are committed and shared. A key in one would breach the Eque2 data-loss-prevention rules. The sites catalogue tags config token handling as `S` at `config.ts:431`. The review found that a hard schema error would make the whole global config fall back to defaults (`config.ts:356`), so the user chose ignore-plus-warn on 2026-09-28.

**Alternatives**
- Hard schema rejection. Rejected by the user: one bad key would reset every global user setting.
- Allow the key with a warning. Rejected: a warning does not stop the commit.

### Decision: the runtime scope layer (layer 5)

**Choice** — Add a `LogPolicy` `Context.Reference` with `content` and `categories` overrides, as shown in §Configuration layers. The sink reads it from `options.fiber` for each record.

**Workflow** — `bmad-testarch-atdd` in stage 2. Then `bmad-build` in stage 3.

**Justification** — A support engineer can turn on `hash` or `full` content for one session's fiber tree. Every other session keeps the redacted default. §Configuration layers names this layer and records that the sink does not read it yet.

**Alternatives** — A process-wide toggle. Rejected: it widens exposure to every session at once.

### Decision: per-sink log levels

**Choice** — Set the global `References.MinimumLogLevel` to the lowest level that any active sink needs. Then make the file, stderr and OTLP loggers filter to `OPENCODE_LOG_LEVEL` themselves, as the Datadog sink does now.

**Workflow** — `bmad-testarch-atdd` in stage 2. Then `bmad-build` in stage 3.

**Justification** — §Limits says the global level filters before any sink, so `Debug` in Datadog also forces `Debug` in the file log. Independent levels are a configuration layer that the brief asks for.

**Alternatives** — Document the coupling only. Rejected: operators then pay for debug file logs to get debug Datadog logs.

## Delivery

### Decision: failure handling

**Choice** — Honour `429` and `Retry-After`. After retries fail, turn the sink off for 60 seconds, as `OtlpExporter` does, and drop the buffer. Emit one `logDebug` to the other sinks each time it turns off.

**Workflow** — `bmad-testarch-atdd` in stage 2, using a local `Bun.serve` intake that returns `429` and `503`. Then `bmad-build` in stage 3.

**Justification** — §Limits records "drops a batch after three retries". Without a circuit breaker, an intake outage makes every flush retry. That wastes the client's network and CPU.

**Alternatives** — A disk spool (see the next Decision). Unbounded retry. Rejected: the buffer grows without limit.

### Decision: no disk spool

**Choice** — Do not add a disk spool. Record the choice as a `ponytail:` comment in `datadog.ts`, and keep it in §Limits.

**Workflow** — `bmad-build` in stage 3 (comment and doc only).

**Justification** — A spool writes redacted records to disk a second time. The file log already keeps a local copy. Log loss during an outage is acceptable for telemetry, and no requirement says otherwise.

**Alternatives** — A bounded spool in `Global.Path.log`. Rejected until a requirement appears. It adds file-retention rules and data-loss-prevention review for little gain.

### Decision: payload compression

**Choice** — Gzip each batch with `Bun.gzipSync` and send `Content-Encoding: gzip`. Keep the 5 MB chunk limit on the uncompressed size.

**Workflow** — `bmad-build` in stage 3. Extend the existing intake test to decompress the body.

**Justification** — §Limits lists no compression. Log JSON compresses well, and Datadog's HTTP intake accepts gzip. Stage 3 must confirm gzip support against the Datadog Logs API documentation before it merges this.

**Alternatives** — No compression. Rejected: it is cheap to add, and client bandwidth matters on remote connections.

### Decision: flush on shutdown

**Choice** — Prove with a test that disposing the runtime flushes the buffer. Fix the scope wiring if the test fails.

**Workflow** — `bmad-testarch-atdd` in stage 2. Then `bmad-build` in stage 3.

**Justification** — §Pattern 3 claims `Logger.batched` flushes when the scope closes. The sites §Existing infrastructure shows `Observability.layer` mounted in several runtimes. One short CLI run must not lose its last records.

**Alternatives** — Trust the Effect docs. Rejected: the claim is cheap to prove and costly if wrong.

### Decision: the duplicate listener instance

**Choice** — Accept the second sink instance that `opencode/src/server/server.ts:132` builds with a fresh memo map. Document it, and add no code.

**Workflow** — `bmad-build` in stage 3 (doc only).

**Justification** — §Limits explains that each instance batches only its own runtime's records, so nothing is sent twice. Sharing the memo map would change server layer lifetimes, which is outside this plan's scope.

**Alternatives** — Pass the shared memo map. Rejected: it changes server lifetime behaviour for a small saving in connections.

## Redaction and data-loss prevention

### Decision: value-pattern scrubbing

**Choice** — Extend redaction beyond key names and Bearer tokens to known secret shapes in string values: `sk-…`, `AKIA…`, `ghp_…`, `xox…-` and URL query parameters named `key`, `token` or `api_key`. Put the patterns in one table.

**Workflow** — `bmad-testarch-atdd` in stage 2, with one fixture for each secret shape. Then `bmad-build` in stage 3.

**Justification** — Sites §Gaps item 4 lists logs that carry free text today. Examples are `permission/index.ts:74` (command patterns), `pty.ts:185` (cmd and args) and the Exa key in a web-search URL. A key-name rule cannot catch a secret inside a message string.

**Alternatives** — Reuse the redaction in `llm/src/route/executor.ts:39-208`. Rejected as a dependency, because `core` must not import `llm` internals for this. Stage 3 should copy its patterns where they fit.

### Decision: default category exclusions

**Choice** — Change the `OPENCODE_DATADOG_CATEGORIES` default from `*` to `*,-question,-pty`, so user answers and keystrokes never leave the machine by default.

**Workflow** — `bmad-build` in stage 3.

**Justification** — Sites §Gaps item 4 names `question/index.ts:124` (raw answers) and the PTY records as `U` and `S` content. `Pty.create` (`pty.ts:185`) logs the command and its arguments. `Pty.write` carries keystrokes, but after the dev merge it has no log, so the exclusion guards any future log there. A default must be safe under the Eque2 data-loss-prevention rules.

**Alternatives** — Rely on content redaction. Rejected: these records carry the sensitive text in the message field, not under a content key.

## Documentation

### Decision: operator documentation

**Choice** — Add the Datadog switches to the environment variable table in `opencode/packages/web/src/content/docs/cli.mdx`. Update §Limits and §Datadog sink switches in `logging-patterns.md` so they match the shipped behaviour.

**Workflow** — `bmad-build` in stage 3.

**Justification** — The switches are a public operator interface. The specs are the design record this plan follows, so they must not go stale.

**Alternatives** — Specs only. Rejected: operators read the product docs, not `specs/`.

## Governance

### Decision: the design review gate

**Choice** — Treat the user's approval of this plan, together with `logging-patterns.md`, as the design review that `opencode/AGENTS.md` requires before a core product feature.

**Workflow** — This stage-1 approval gate.

**Justification** — The patterns document already records the design, its alternatives and its trade-offs. A second review document would repeat it.

**Alternatives** — A separate design review before stage 2. The user can ask for one at approval.

### Decision: where the sink lives

**Choice** — Keep the sink in `opencode/packages/core/src/observability/`, beside `otlp.ts`.

**Workflow** — None (no move).

**Justification** — The sink is a host-generic transport, like the OTLP logger. It holds no Eque2 policy, so the fork policy in `AGENTS.md` allows it. Eque2 audit rules belong in pattern 6, as §Recommended combination says.

**Alternatives** — Move it into the Eque2 plugin (pattern 6). Rejected: §Pattern 6 cons say that plugins see V1 hooks only and lose trace correlation.

## Revision history

- **2026-09-28, stage 2 Phase R.** The adversarial and edge-case reviews found that the config-file and API key Decisions could not hold as written. The user answered three questions: global files only, narrow-only file settings, and ignore-plus-warn for `apiKey`. The user then chose "Revise and approve". This revision replaces the approval of hash `681261f1`.

- **2026-09-28, dev merge.** The user asked for `dev` to be merged, because it carries the Effect lint migration. The merge (`a04610c20f`) moved code that this plan cites. Line references were updated: `config.ts` 298 to 356 and 371 to 431, `server.ts` 124 to 132, `executor.ts` 41-202 to 39-208, `question/index.ts` 125 to 124, and `pty.ts:185` added. The `Pty.write` wording was corrected, and the lint scope was added to Lane. No Decision's Choice changed.

## Worktree

- **Path:** `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/datadog-log-sink`, inside the `opencode` Git repository. The workspace root is not a Git repository.
- **Branch:** `datadog-log-sink`. This deviates from the skill default `goal/datadog-log-sink`, because `opencode/AGENTS.md` requires a branch name of three words or fewer with no type prefix.
- **Base:** the current `HEAD` of `effect-v4-update`. The worktree must include the three sink commits and the two spec commits. It must not branch from `dev`.
- **Ignore rule:** `opencode/.gitignore` ignores `.worktrees` but not `.claude/worktrees/`. Stage 2 must add `.claude/worktrees/` to `.gitignore` in its own commit.

## Lane

**Heavy.** These conditions triggered it:

- It changes more than two existing files and adds new test files.
- It changes a public interface: the config schema and operator env vars.
- It touches a security path: data-loss-prevention redaction.

After the dev merge, `lint:effect-eslint` covers every `packages/*/src`, so the sink code must pass the Effect lint rules. The config schema change can alter generated client types. Stage 3 must run `bun run check:generated` in `packages/client` and `bun typecheck` at the repository root.

## Declined workflows

| Workflow | Reason |
| --- | --- |
| `bmad-prd` | One epic in one package. The brief plus `logging-patterns.md` carry the requirement. |
| `bmad-architecture` | The architecture is decided and recorded in §Pattern 3 and §Recommended combination. No new service, store or boundary. |
| `bmad-create-epics-and-stories` | One workstream. Stage 2 writes a flat task list. |
| `bmad-deep-recon` | No unknown technology. Stage 3 checks the Datadog gzip support against the vendor docs. |
| `bmad-brainstorming` | The choice among patterns is made in `logging-patterns.md`. |
| `bmad-testarch-test-design` | The coverage shape is not in question: one ATDD suite in `observability-datadog.test.ts` with a local intake. |
| `eque2-code-create-spec` `[CS]` and `eque2-code-develop-spec` `[DS]` | Not installed (see Skill availability). The heavy lane would select them. Stage 2 writes `ACs.md` directly, `bmad-testarch-atdd` writes the failing tests, and `bmad-build` builds against them. |

## Skill availability

- **Installed** (workspace-root `.claude/skills` and `.agents/skills`): `bmad-build`, `bmad-testarch-atdd`, `bmad-prd`, `bmad-architecture`, `bmad-create-epics-and-stories`, `bmad-deep-recon`, `bmad-brainstorming` and `bmad-testarch-test-design`.
- **NOT INSTALLED** in any skills root:
  - `eque2-code-create-spec` and `eque2-code-develop-spec`. The closest alternative is `bmad-testarch-atdd` followed by `bmad-build`.
  - `eque2-code-create-pr`. The closest alternative is a manual `gh pr create` after the user asks for it.
  - `eque2-code-e2e-test`. No alternative is needed, because no user journey changes.
- **Stage 2 must not bind a NOT INSTALLED workflow.** This plan names none as a stage-2 or stage-3 workflow.
- **Setup marker:** neither project skills root has `eque2-code-setup`. Stage 2 should confirm the skills root before it binds.

## Research

No research is needed. The earlier session read the pinned Effect `4.0.0-rc.117` source for `Logger.batched`, `Logger.formatStructured`, `Fiber.cache.span`, `Config` and `ConfigProvider`. The findings are in `logging-patterns.md`. The only open external fact is Datadog intake gzip support, and stage 3 checks it against the vendor documentation.
