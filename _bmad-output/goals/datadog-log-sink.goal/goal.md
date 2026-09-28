> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

> **GOAL-READY 2026-09-28** — datadog-log-sink, spec-backed,
> adversarially reviewed; SPEC produced this run. Drive with your agent's
> completion loop (`pursue-goal`, which binds the stop gate). See SPEC + journal
> below for full contract.

> **Build via BMAD.** The SPEC was produced during goal-prep (linked in
> the frontmatter below). To IMPLEMENT it, use `bmad-testarch-atdd` →
> `bmad-build` → `bmad-code-review`. To re-spec
> if requirements shifted, use `bmad-spec`. Do NOT pause to ask *how* to
> build; this is the answer.
>
> _Agent note — other agents: follow the equivalent create-story →
> failing-tests → implement → review procedure; see
> `references/agent-mapping.md`._

> **Run autonomously (YOLO).** When this charter is executed, run it
> end-to-end **without stopping to ask permission**. Resolve issues
> automatically — investigate-and-fix a failing test, a missing file, an
> unfamiliar flag, a crashed tool; do NOT escalate them. Default
> decisions, never questions:
> - **A fidelity question → choose the HIGHEST fidelity** (full universe /
>   full dataset / the sanctioned venue; never a reduced or local sample
>   as the verdict).
> - **A scope question → choose the WIDEST scope** consistent with the
>   stated intent (do the complete job, not a slice).
> - Do NOT ask *how* to build (the Build-via directive is the answer) or
>   *whether* to spend on the sanctioned compute (yes).
> **Validate before you fan out — MANDATORY, no exceptions.** Autonomy and
> widest-scope do NOT mean launching N parallel/expensive workers on
> unproven code. Before any fan-out (multiple VMs/jobs, a large batch, a
> costly parallel sweep) you MUST, in this order: (1) test the code
> thoroughly (the suite is green); (2) run ONE small real subset
> end-to-end in the LIVE environment — a single VM / a handful of items /
> one shard — and confirm it actually succeeded (correct output, no
> errors, expected cost); only THEN scale to the full fan-out. One canary
> that passes earns the fleet; an unvalidated fleet is forbidden even
> under YOLO. The widest-scope default applies to the *eventual* run,
> never to the first launch. (A single bug fanned across 25 VMs cost $700
> — this gate exists to prevent exactly that.)
> Stop ONLY for a genuine blocker: an interactive credential/auth the
> owner alone can clear, an external precondition outside your control
> (quota exhausted, required data absent), or an ambiguity that would
> change the *verdict* and has no defensible highest-fidelity/widest-scope
> default. Report cost/outcome **after** the fact, not as a gate before
> it. Never fabricate a verdict — it must come from the real run; an
> honest negative is a valid outcome to surface, not a stall.

# Goal: develop pattern 3, the Datadog log sink

## Links

| What | Where |
| --- | --- |
| Approved plan (the contract) | [`./plan.md`](./plan.md) |
| Story and resolved design details | [`./spec/story.md`](./spec/story.md) |
| ATDD checklist and test strategy | [`./spec/atdd-checklist-datadog-log-sink.md`](./spec/atdd-checklist-datadog-log-sink.md) |
| Acceptance contract | [`./ACs.md`](./ACs.md) |
| SPEC provenance | [`./MANIFEST.md`](./MANIFEST.md) |
| Journal | [`./JOURNAL.md`](./JOURNAL.md), [`./journal/`](./journal/) |
| State | [`./STATE.md`](./STATE.md) |
| Contract review | [`./reviews/`](./reviews/) |
| Original prompt | [`./prompt.md`](./prompt.md) |

The design record lives outside this folder, at these repository paths:

- `specs/observability/logging-patterns.md`: §Pattern 3, §Configuration layers, §Datadog sink switches, §Limits of the current sink.
- `specs/observability/logging-sites.md`: §How to read the tables, §Existing infrastructure, §Gaps to close first.

The red tests are at `packages/core/test/effect/observability-datadog-atdd.test.ts`.

## Original request

> Use opencode/specs/observability docs to plan the development of approach 3. Ensure the plan refers to these docs.

## Resolved decisions

The approved Decisions are in [`./plan.md`](./plan.md). The plan was revised and re-approved on 2026-09-28, after the Phase R review: global files only, narrow-only file settings, and ignore-plus-warn for a file `apiKey`. Stage 3 executes it without re-litigating.

The full design detail is in [`./spec/story.md`](./spec/story.md) §Resolved design details, items 1 to 20. That section is binding for stage 3. The main points:

- Only the global config files are read. The file layer is narrow-only, and `url` is env-only.
- `Datadog.withPolicy` merges policies field by field. Secrets stay redacted in every mode.
- Log levels are per sink. The global minimum is the lowest active level.
- The status rules, `Retry-After` with a 30-second cap, a 60-second breaker (with a `cooldown` option), and a 10,000-entry buffer cap.
- A bounded final flush at shutdown.
- UTF-8 chunk sizing, gzip, and a 1 MB entry cap.
- The default categories are `*,-question,-pty`. `answers`, `cmd` and `data` become content keys. Secret keys and value patterns have word boundaries.

## Task list

Work in this order. Each task ends with its ATDD leaf and its `AC-nb` tests passing, then one atomic commit with Why, Source and Notes.

1. **AC-10 and AC-10b:** default categories, plus the new content keys.
2. **AC-9 and AC-9b:** secret-key rule with word boundaries, and value scrubbing everywhere.
3. **AC-7 and AC-7b:** gzip and UTF-8 chunking. Record the Datadog documentation citation in `./STATE.md`.
4. **AC-5 and AC-5b:** status rules and `Retry-After`.
5. **AC-6 and AC-6b:** breaker, cooldown option, breaker record and buffer cap.
6. **AC-8 and AC-8b:** bounded final flush, and `Observability.layer` disposal.
7. **AC-3 and AC-3b:** `Datadog.LogPolicy` and `Datadog.withPolicy`.
8. **AC-4 and AC-4b:** per-sink levels in `logging.ts`, `otlp.ts` and `observability.ts`.
9. **AC-1 to AC-1e, AC-2 and AC-2b:** the `observability.datadog` schema, `Datadog.provider`, and the narrow-only file layer. Regenerate clients (`bun run generate` in `packages/client`, `./packages/sdk/js/script/build.ts`) and run `bun run test:httpapi` in `packages/opencode`.
10. The `ponytail:` comment for no disk spool.
11. **AC-11:** `packages/web/src/content/docs/cli.mdx` and `specs/observability/logging-patterns.md`.
12. The full quality gate, then the live Datadog check for the binding verdict.

## Test sketch

- The ATDD leaves are at `packages/core/test/effect/observability-datadog-atdd.test.ts`: AC-1 to AC-10, with a local `Bun.serve` intake, temp config dirs and `ConfigProvider.fromEnv`.
- The existing tests are at `packages/core/test/effect/observability-datadog.test.ts`, and must stay green.
- For AC-5b, AC-6b and the default cooldown, provide `TestClock` before `Datadog.logger` builds. The flush fiber keeps the Clock from build time.
- Name each secondary test with its `AC-nb` id, so the gate can find it.

## Observability to wire

This goal is the sink itself. It emits one record of its own: the `logDebug` when the circuit breaker turns the sink off. That record goes to the other sinks, never to Datadog itself.

## Ready-to-execute commands

```sh
cd /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/datadog-log-sink
bun install                                  # then revert bun.lock and packages/cli/bin/lildax.cjs if Bun != 1.3.14 changes them
cd packages/core && bun test test/effect/observability-datadog*.test.ts && bun typecheck
cd ../client && bun run check:generated
cd ../opencode && bun run test:httpapi
cd ../.. && bun run lint && bun typecheck
```

_Agent note: Claude Code runs `bmad-testarch-atdd`, `bmad-build` and `bmad-code-review` as skills. Other agents follow the same failing-test, implement and review order._

## Contract review

Phase R ran two lenses, adversarial and edge-case, and produced 29 findings. All were applied in this run. Three needed the owner, and the owner answered them and re-approved the plan. See [`./reviews/2026-09-28-phase-r.md`](./reviews/2026-09-28-phase-r.md).

## What this skill did NOT do

- It did not implement any AC. Only red scaffolds and one characterisation test exist.
- It did not run `[CS]` or `[DS]`, because they are not installed. The story and the ATDD checklist replace the SPEC.
- It did not run the live Datadog check. That needs the owner's API key.
- It did not start the loop. A fresh context starts it.

## Done when

The acceptance contract for this workstream is [`./ACs.md`](./ACs.md)
(27 criteria). It is the file the gate reads; this charter does not
restate it.

> **An unchecked box is a question, not a verdict.** If an item is still
> `[ ]`, say plainly *why* — then ask whether there is *truly* nothing you
> can do about it. A blocker you didn't create (a pre-existing repo defect,
> a flaky dependency, a broken fixture) is a reason to FIX it, not a licence
> to stop. Almost always there is a next action: investigate it, repair it,
> route around it. Exhaust the autonomous options and complete the item;
> escalate only the genuine blockers listed in this charter's stop rules.

**To drive this hands-off**, open a fresh context and refer to this
folder — naming the path is enough to start it:

```
/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/datadog-log-sink/_bmad-output/goals/datadog-log-sink.goal
```

Or open it as the working directory (`cd <this folder> && claude`, or
`codex`) and it starts itself. The explicit forms —
`/eque2-code-pursue-goal <this folder>` or `pursue-goal <this folder>` —
do the same thing for anyone who wants to be unambiguous.

That binds the stop gate to this folder's `ACs.md` and refuses to let the
run end while any criterion is outstanding. It is the ONLY supported way to
execute this charter — do not paste the criteria into a host agent's
built-in goal command, which judges a conversation rather than an evidenced
checklist and leaves no record of what it judged.
