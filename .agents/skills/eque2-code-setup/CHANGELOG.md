# Changelog

## v0.62.0 — 2026-09-30

- feat: add `[SS]` security scan (`eque2-code-security-scan`). It audits the repository against 50 checks in seven categories — secrets hygiene, auth and access, input and data, AI and agents, failure handling, supply chain and CI, and transport headers — built from a 30-item practitioner checklist extended with OWASP Top 10:2025, API Top 10, LLM Top 10, ASVS 5.0, and GitHub Actions hardening guidance. Findings carry a severity banded to CVSS v4.0 and a confidence; low-confidence findings go to an appendix. Checks code cannot prove (key rotation, spending caps, restore tests) are asked of the owner, or left as needing attestation in `--headless` runs. Writes `report.md`, `remediation-plan.md` (a ready brief for `[PL]`), and `findings.json` to `{output_folder}/security-scans/<date>/`, and marks each finding new, still open, regressed, or resolved against the previous scan. Read-only: it never changes code and never executes its plan.
- feat: `/eque2-code-setup` now installs the AI PR-review GitHub Actions into `.github/` — the Claude Code review, auto-resolution of fixed review threads, and optional Jira verification. The review reads its rules from `.github/review-rules/`, so run `[IS]` afterwards to generate them; setup ends by telling you to, along with adding the `CLAUDE_CODE_OAUTH_TOKEN` secret. Re-running setup updates workflow files you have not changed and never overwrites ones you have — it lists those instead.
- docs: the README install command drops the gds module.

## v0.61.0 — 2026-09-29

- feat: Hannibal's `[PL]` plan-goal now writes the acceptance criteria. A goal folder from stage 1 holds `plan.md` (the index, with links to the input prompt, the decisions, and the ACs, plus the stage sequence, lane, and worktree), `decisions.md` (each technical decision `D1`..`Dn` with its choice, justification, alternatives, and the AC that verifies it), and `ACs.md`. You approve all three together, so the finish line is agreed before any preparation starts and stages 2–3 need no further input on the contract.
- feat: every technical decision with an observable result gets its own `[D<n>]` criterion in `ACs.md`, and `goal.md` links `decisions.md`, so the stop gate checks that the approved decisions were honoured.
- change: `[PG]` prepare-goal no longer writes `ACs.md`. It verifies the approval against hashes of all three stage-1 documents, then only prepends the auto-start banner and appends criteria the SPEC surfaces; it never removes or rewords an approved criterion. **Breaking:** a goal approved under the old layout (a `.approved` marker without `decisions-hash`/`acs-hash`) is refused — re-run `[PL]` on it.
- fix: `[ST]` status reports a no-worktree goal as prepared only once `goal.md` exists, since `ACs.md` now exists from stage 1.
- chore: exempt the scenario reporter's registration helpers from the Effect lint rules.

## v0.60.0 — 2026-09-29

- feat: add `[RV]` code review (`eque2-code-review`). It reviews the current branch's changes locally against the repo's own styleguide review rules — `.ai/Code Reviews/styleguides/` (the GitHub PR-review Action's layout) and `.github/review-rules/` — checking every changed file against every applicable rule, as the Action does. Findings use each styleguide's "PR Review Comment Format"; a report goes to `{output_folder}/code-reviews/` with a severity summary in the terminal. Local only: it never posts to a PR or edits code. Available from the Linus menu; `[PR]`'s own review step is unchanged.
- feat: open scenario id grammar. Any uppercase prefix now routes — `S1`, `AU3`, `DELIVERY-2`, `C4-RESET.1` — not only `S<n>`, `BUILD-<n>` and `C<n>`. The grammar is defined once and shared by the reporter, the state CLI, the definitions schema, and the create-spec scripts, so a spec can no longer hold scenarios that never produce evidence.
- fix: `verify` now reads the result in the evidence. It refuses evidence with a non-zero exit code, any failing test, or no passing test; previously it reported `testPassed: true` whenever the signature and hashes checked out, so a failing scenario could complete as verified. A traceability-only failure no longer spends a retry. Correct a wrongly completed scenario with `update <id> suspect`, re-run the test, then `verify`.
- fix: `state init` refuses unroutable or ambiguous definitions at spec time: an id outside the grammar, a testFile whose name does not route to its scenario, a duplicate id, a task-shaped scenario id (`T1`), or a build-check id without `BUILD-`.
- fix: the scenario reporter no longer skips silently. It warns about a `verify-*` file with no routable id, reads tags on nested `it()` blocks, records a file-level load failure as a failing test, writes no evidence for a scenario from a file other than its registered one, and warns when it cannot read the state store.
- feat: setup reports drift between the `.claude` and `.agents` installed copies of `eque2-code-setup` (`bundle-parity-check.py`).

## v0.59.0 — 2026-09-20

- fix: `state init` no longer destroys recorded progress. Initialization now creates what is missing and preserves what exists: an actor that already holds a snapshot at the current machine version keeps it, and the `skipped` count in the response reports how many were preserved. Previously every surviving actor was re-seeded unconditionally, so a second `init` against a live spec folder turned a `building` task back into `not_started` with a freshly stamped `_integrity`, and stripped the evidence from under a `completed` one. A stale-`_machineVersion` survivor is still restamped — it is unreadable until it is, and that remains the documented deadlock recovery counted in `migrated`. Guarded by `state-init-idempotency.test.ts`.
- fix: register the Codex goal gate in the project instead of relying on the active Codex home. Air and other harnesses can use separate Codex homes, so a user-level registration from another harness does not load. The standard setup writes one harness-neutral project hook, installs a stable main-checkout gate for linked worktrees, and requires proof from the exact project command and Codex home before it writes loop state. An upgrade keeps the trusted user fallback until that home proves the project hook. A later setup run removes only the stamped eque2 user gate and preserves unrelated hooks.
- fix: add a post-install Stop hook audit. Setup now reports `passed`, `pending-trust`, or `failed`, names each checked hook source, validates required helpers and owned fallbacks, rejects unsafe duplicates and wrappers, and keeps unrelated hooks unchanged.
- fix: replace the Codex two-Stop terminal with one single-use recovery acknowledgment for each progress state. The acknowledgment credits one accidental Stop, keeps raw history, changes no goal evidence, and leaves later Stops on the standard stall thresholds.
- chore: make the publish and marketplace workflows invoke the `semver` skill automatically. Publish applies the recommendation unless the user supplies an explicit override. Marketplace reports the recommendation without changing versions.

## v0.58.0 — 2026-08-22

- feat: add direct inline goal pursuit. An explicit “pursue the goal of …” request now creates a complete direct contract in the current checkout, validates its acceptance criteria and charter, and starts the existing stop gate without plan approval or goal preparation. The contract includes durable `prompt.md`, `DIRECT.md`, `goal.md`, `ACs.md`, `CLAUDE.md`, and `AGENTS.md` records. Generic tasks still use `[PL]`, and prepared goal folders still use `[PU]`.
- fix: improve the goal-gate installation and proof path, including its registration checks and test coverage.

## v0.56.0 — 2026-08-21

- feat: add a goal handover workflow. It writes a goal-local `handover.md` that a fresh context can reference to validate, adopt, and continue the active goal safely.
- feat: add Hannibal's `[HO]` handover route and the `/eque2-code-handover-goal` shortcut. Pursue Goal routes a handover document to this workflow, so it does not start a second loop.

## v0.55.0 — 2026-08-21

- feat: pre-flight check 7 accepts the `bmad-project-context` block in `AGENTS.md` as project context. `bmad-document-project` — the workflow the check was built around — is retired, and its replacement deliberately writes a small verified block instead of a `docs/` tree with an `index.md` marker. The check looked only for that marker, so on a project that had done the current thing correctly it warned forever, and the warning told the owner to run a workflow that no longer exists. Either marker now satisfies it: the `<!-- bmad:context -->` block (checked automatically, no flag), or the legacy index via `--project-docs-glob` for repos that still carry one. Nothing regenerates the legacy index; the flag's help says so.
- fix: eque2-code's own skills stopped naming deprecated BMad skills. Every reference across the agent, spec, build, bug-fix, E2E, goal and setup skills now names the current workflow — `bmad-review` with a named lens in place of `bmad-review-adversarial-general` and `bmad-review-edge-case-hunter`, `bmad-build` in place of `bmad-quick-dev` / `bmad-create-story` / `bmad-dev-story`, `bmad-deep-recon` with a named type in place of the three research shims, and `bmad-project-context` in place of `bmad-document-project`. The shims still forward, so nothing was broken — but a module that tells its owner to run a retired workflow teaches the wrong habit, and the forwarding hop is a silent tax on every invocation.
- fix: the goal skills no longer bind `wds-4-ux-design`, a skill this repo dropped with the Whiteport tree. Design work in a plan now names `bmad-ux`.

## v0.54.5 — 2026-08-20

- fix: prepare-goal asks what to do about a dirty main checkout instead of walking past it. The new worktree branches from `HEAD`, so uncommitted work in the main checkout does not come with it — and the goal then builds against a base the owner believes is there, surfacing much later as code that mysteriously does not exist. Phase W now runs `git status --porcelain` (excluding the goal's own folder, dirty by construction) and, on any output, stops with the paths and four choices: commit them first (recommended), bring them along via a stash applied in the worktree, proceed without them, or cancel. The answer is journalled, "proceed without" is named in the hand-off, and committing or discarding the owner's work unasked is now a listed anti-pattern.

## v0.54.4 — 2026-08-20

- fix: goal worktrees are created **inside the repository**, at `{project-root}/.claude/worktrees/<slug>` (`.agents/worktrees/<slug>` on a Codex-only install) — the same agent-managed root `[DS]` develop-spec already uses. The old path discovery ended in a `<repo>-<slug>` **sibling** fallback, so an ordinary repo scattered goals outside itself. Only a path the user names, or `git config eque2.worktreeRoot`, moves it now; plan-goal, prepare-goal, and the anti-patterns list all state the same rule, and the create step first excludes `/.claude/worktrees/` so the nested worktree never lands in either tree's `git status`.
- fix: a `verdict … rejected` is recordable on a scenario that never passed Layer 1. The trust graph had no `untrusted → suspect` edge, so the one moment a negative verdict matters most — evidence that already failed, or was demoted — was the one moment it could not be written. A ledger that can record 'proven' but not 'disproven' only ever collects good news.
- fix: the Layer-1 Gherkin gate now checks **traceability**, not verbatim quotation. The old rule (≥50% of Gherkin step text appearing somewhere in the file) passed a hollow test that pasted the scenario into a header comment and failed a real one that paraphrased it — line-wrapping a doc comment was enough to flip it. What remains is what a machine can honestly check: the file names the scenario it claims to prove, via the `verify-{FEATURE}-{ID}.spec.ts` filename or an `[S{N}]` title tag. Judging the assertions stays Layer 3's job.
- fix: `fail` and `reset` report only what the ledger actually persisted. When neither transition was legal the snapshot was untouched, but the response still announced the demotion — the response contradicting the state it describes.

## v0.54.3 — 2026-08-19

- fix: pursue-goal switches into the goal's worktree before it starts. A goal folder quoted from the main checkout — the usual way an owner hands one over — used to run the starter, the stop gate, and the whole build against the wrong tree. Step 2 now names the switch (`EnterWorktree` for Claude Code, a fresh context rooted at the worktree for other agents), routes the `.moved` stub and the main-checkout ghost through it, and keeps the refusal only for a switch that cannot be made.
- fix: prepare-goal stamps a worktree-switch block into every goal folder's `CLAUDE.md` and `AGENTS.md` (emitted-charter §0a), naming the worktree root and branch resolved from disk. Goals prepared in place omit it.

## v0.54.2 — 2026-08-18

- fix: parent task snapshots no longer carry a `subtaskActors` mirror of their children. The map was written once at init and never invalidated, so it reported every child as `not_started / untrusted` long after the children reached `completed / trusted`. Children are addressable by id prefix (`T1.*` under `T1`) — the single source the transition logic already reads. The schema field stays optional and is marked non-authoritative so existing state files still decode.
- fix: `state query` now reports a parent's own aggregated `evidence.trustLevel` instead of a hardcoded `untrusted`. A parent could previously answer "is T1 trusted?" two contradictory ways with no way to tell which was authoritative.
- fix: the anti-tamper policy now protects the enforcement PROGRAMS, not only the data they guard. Clause (5) names the state/tests CLIs, reporters, hooks, and goal-gate scripts, and states the sanctioned change path: an owner instruction or an upstream release, landing as its own commit with the contract diff. Matching `Edit(...)` deny rules ship for both the `.claude` and `.agents` trees and the machine-global gate runtime.
- fix: the Codex goal-gate recovery guard puts its recovery instruction in the model-visible `reason` channel, and ends an unrecoverable Codex loop honestly instead of blocking forever. Claude's warning and terminal thresholds are unchanged.

## v0.54.1 — 2026-08-13

- feat: [JF] Jira fetch now downloads ticket attachments (images, PDFs, logs) to `jira/attachments/` — for the main ticket and every related ticket fetched — with a 25MB size guard and warn-and-continue on per-file failures; attachments are listed in `ticket.md`

## v0.54.0 — 2026-08-13

- feat: **Hannibal — a third agent that plans, prepares, and pursues goals through three gated stages.** `/eque2-code-agent-hannibal` presents `[PL]` plan, `[PG]` prepare, `[PU]` pursue, `[ST]` status, and `[GG]` loop inspection. Every task, however small, gets the goal folder, the plan, the approval gate, the acceptance criteria, and the bound stop gate — "lightweight" selects cheaper workflows, never less ceremony.
- feat: **`[PL]` plan-goal (new skill) — decisions on paper before anything is built.** Stage 1 writes `_bmad-output/goals/<slug>.goal/plan.md`: one `### Decision:` block per choice with Choice / Workflow / Justification / Alternatives, plus the worktree decision, the light/heavy lane call, declined workflows, and inline research findings. Workflows come from an authoritative inline decision matrix (18 rows, UX and design lanes included), every named skill disk-verified — a missing one is marked NOT INSTALLED with the closest alternative, never silently dropped. The run stops at the approval gate: the user's explicit word writes `.approved` with a `git hash-object` plan hash; enthusiasm, silence, and questions are not approval.
- feat: **`[PG]` prepare-goal rewritten as Hannibal stage 2 — it now builds an APPROVED plan, and only an approved plan.** Pre-flight refuses without the `.approved` marker (an explicit `--force` records `approved-by: OVERRIDE`, reported by `[ST]` — it never suppresses the marker), and re-hashes `plan.md` against the marker so a plan edited after approval voids it. It then creates the decided worktree on `goal/<slug>`, MOVES the goal folder in (one live copy, ever), leaves a `<slug>.moved` stub in the main checkout, and builds the plan's lane: `[CS]` SPEC into `X.goal/spec/` on the heavy lane, directly-written ACs with an honest "no spec pipeline" manifest on the light lane. Same skill name, same paths — the goal-gate contract and the Stop-hook registration are untouched, and an in-flight `X.goal/` keeps working.
- feat: **`[PU]` pursue-goal rewritten as Hannibal stage 3 — it honours the move.** Handed a `.moved` stub it follows `moved-to:` to the canonical worktree copy; handed the main-checkout ghost of a moved goal it refuses and names the worktree; a stub whose worktree is gone is reported stale, never silently recreated. The gate machinery, exit-code contract, and bootstrap-turn discipline are unchanged.
- feat: **`[ST]` goal status, derived from disk, never stored.** A directory scan of `_bmad-output/goals/` (stubs followed into worktrees, `git worktree list` never consulted) resolves each goal to stale / done / pursuing / prepared / approved / planned — first match wins — with AC tallies from the gate's own checker and OVERRIDE / voided-approval annotations. No status field exists to disagree with reality.
- chore: **The inherited goal gate changed by exactly two lines** — `install.sh`'s `GG_SKILLS` and `pursue-goal.sh`'s worktree provisioning loop now also place `eque2-code-plan-goal` and `eque2-code-agent-hannibal`. `goal-gate-stop.sh` is untouched; the full gate suite runs 1839 tests green. (Note for reviewers: the `[PG]`/`[PU]` diffs are rewrites shipped in place, not edits — same skill names so the gate's references and hook registration survive without migration.)
- chore: **The help catalog knows the chain.** New HANNIBAL and PL rows; PG/PU rows rewritten with the stage framing; `[TD]` briefs now feed `[PL]`. The chain reads plan-goal → prepare-goal → pursue-goal → journal.
- fix: **The pre-push hook no longer leaks `GIT_DIR` into the test suite.**

## v0.53.0 — 2026-08-10

- feat: **A criterion that can never be met can now be written down, and it stops nudging you.** Mark it `- [!] ` with an indented `- blocked: <reason>` line. A blocked criterion is neither met nor outstanding: it leaves the outstanding count, so it stops driving the turn-end message, and it never enters the met count, so blocking never buys a pass. Previously an impossible criterion held `unchecked > 0` for ever and the loop ran until an operator noticed.
- feat: **`LOOP_PARTIAL` — an honest ending for a goal whose remaining work is impossible.** With every non-blocked criterion met and evidenced and at least one blocked, the loop ENDS as a reported non-completion: no completion record is written, no criterion is marked met, and the report names every blocked criterion with its reason, marking a blocked `**CRITICAL**` one as such. A checklist whose criteria are ALL blocked is not a pass — zero met is still zero met.
- feat: **The ordinary turn-end refusal now tells you how to declare a blocker, and what it costs.** It appears on turn one, not after eight idle turns in the stall message. Not knowing an honest exit existed was the direct cause of the reported looping: an agent that cannot see one keeps retrying the exit it will never reach. The message says plainly that blocking does not pass, so it reads as an accounting rule rather than an invitation.
- feat: **The blocked signal is keyed to its workstream** — `<workstream>.LOOP_BLOCKED`, mirroring `<workstream>.state`. One gate directory holds many loops, and a bare `LOOP_BLOCKED` meant one session's blocker ended another session's unrelated run and silenced bystanders that had no goal at all. A bare file left by an earlier version is REPORTED with the exact `mv` correction and honoured for nobody; `install.sh migrate-signal` attributes it automatically, but only when exactly one workstream exists — ownership is otherwise a guess, and guessing ends the wrong loop.
- feat: **`pursue-goal` provisions the checkout it is starting in.** A goal folder prepared in a git worktree arrived without the gate machinery, because it is untracked in the originating checkout and `git worktree add` copies tracked files only — so the starter refused with "the gate is not registered" while a working copy sat one directory away. It now copies the gate and goal skills and the Stop registration across, reporting each item, and only then runs the registration check. The refusal survives for the case it was written for: nothing to copy from.
- feat: **The gate answers "is a loop in operation here?" first, and returns immediately when the answer is no.** A file-existence test for a workstream state file or a co-located `ACs.md`, ahead of the claim handshake. A conversation with no goal no longer exercises generation counting, lock acquisition and stale reclaim before being told none of it applied.
- feat: **`cancel.sh status` reports met, outstanding and blocked counts and names each blocked criterion with its reason** — including after the loop has ended, which is when anyone actually asks. Blocked declarations also reach the run log with the workstream, the criterion, the reason and a timestamp.
- fix: **Gate messages no longer hand you an internal workstream key.** A terminal message pointed the reader at `.goal-gate/_anon-b5fc67b123703245.state` — a hash with no connection to the work they were doing. The hash exists because the loop file is written before any session exists to name it. Messages now name the goal folder; the key stays in the state file, run log and decision trail, where a machine reads it.
- fix: **A blocker raised through the loop-state file had its reason swallowed.** Writing `status=LOOP_BLOCKED` — the documented way for a skill to raise one without touching the gate directory's layout — hit the generic "already reached a reported END" stand-down on the very turn it ended, so the operator was told "this already ended" instead of "this ended, and here is why". A terminal status that has never been announced now falls through exactly once to be reported. `cancelled` is deliberately unchanged: letting it fall through is what made a cancelled loop inescapable.
- fix: **Evidence quoting the gate's own output was refused as surrogate-evidenced.** The surrogate rule matched `standin` as a bare substring, and "outstanding" contains it — so `1 met, 0 outstanding` in an evidence line was rejected as a stand-in reference, making the honest record unwriteable. That token now matches with a word boundary; `mock`, `stub`, `fake` and the rest stay substring matches, because those genuinely appear glued to other words.
- fix: **A wait-suite assertion depended on the terminal stall landing on an exact turn count.** It ran the gate four times and asserted on the fourth; once the stall landed on turn three, the correct stand-down on turn four read as a failure to stall at all. It now stops at the turn that produces the terminal end.
- test: **New `test-blocked-criteria.sh` end-to-end suite (43 tests)**, driving the real hook from an authored checklist to the decision on stdout and the files on disk, plus blocked-state coverage across the format, parser, validator, charter, decision, stall and bystander suites. The full gate runs 1839 tests green.

## v0.52.0 — 2026-08-07

- fix: **`state status` and `state done` no longer disagree about whether a job is finished.** `status` reported `done: true` the moment every actor reached a terminal state, while only `done` applied the trust gate — so a run whose actors were terminal but never earned trust read as complete from one verb and incomplete from the other. Reading the wrong one reported success over an unfinished job. Both verbs now evaluate the same gate (snapshot integrity, trust level, and scenario evidence authenticity), and `status` names the untrusted actors in `warnings` instead of staying quiet about them.
- feat: **`prepare-goal` creates a git worktree for the workstream and works inside it.** The main working tree is never disturbed — nothing is written into it and its branch, index, and working state are left as found. Where the worktree goes follows the repo's own convention: `git config eque2.worktreeRoot` if set, otherwise the habit visible in `git worktree list`, otherwise a `<repo>-<slug>` sibling. The chosen path is named in the hand-off. Not a git repo, or the worktree cannot be created, falls back to preparing in place and records why.
- feat: **every document a prepare-goal run produces now lands in the goal folder, including the SPEC.** The spec pipeline is pointed at `X.goal/spec/` and writes there directly, so nothing is left behind in `_bmad-output/features/<slug>/`. `mirror-spec.sh` gains an `in-place` verb that records `spec/` as its own canonical source; `verify` accepts that manifest, refuses an empty `spec/`, and refuses a manifest claiming both in-place and an external source. The `mirror` form remains as the fallback for a pipeline that genuinely cannot be redirected.
- feat: **referring to a `.goal` folder now starts it.** `pursue-goal` triggers on any reference to a path ending in `.goal` — named, pasted, or attached — because there is nothing else one does with a prepared goal folder. It starts immediately rather than asking whether to proceed or summarising the charter back.
- feat: **a prepared goal folder carries its own start instructions.** `prepare-goal` writes a start-now banner as the first lines of `goal.md` and `ACs.md`, plus `CLAUDE.md` and `AGENTS.md` for when the folder is the working directory. Four copies of one instruction, each covering a different way a reader arrives; an instruction present only in the file they did not open is not an instruction. None are written when the run produced no charter — a folder that auto-starts work against a half-written contract is worse than one nobody opens.
- feat: **`[TD]` — a TODO skill that captures work as a prepare-goal-ready brief.** Interviews the requester, probes the codebase for real file paths and current behaviour, and writes a grounded brief a fresh context can pick up cold, rather than a one-line note nobody can act on later. Also lists the open backlog and marks TODOs done.

## v0.51.4 — 2026-08-03

- fix: **a session that is not driving a goal loop now stands down silently.** The goal gate used to tell every bystander conversation in the tree, on every one of its turns, that a loop was running, who owned it, and that `cancel.sh adopt` could take it over. Meant as a one-off explanation, it read as a permanent banner on conversations doing unrelated work. The stand-down itself is unchanged — nothing is held, nothing is claimed — and it is still recorded on stderr, in `foreign_owner` on the loop file, and as `stood_down_not_owner` in the run log. An owner that is genuinely gone is still reclaimed automatically once its heartbeat ages past the liveness window, with no `adopt` needed.
- fix: **dispatching `eque2-verifier` is now explicitly pre-authorised in the managed CLAUDE.md block.** An agent read "only `eque2-verifier` may mint" alongside a general "don't use subagents unless asked" house rule, concluded it could do neither, and ended a goal loop at 0/17 acceptance criteria to ask permission. The clause states that the restriction governs who may mint, not whether verification happens, and names the hookless `verification-runner.py` path for runtimes without SubagentStart/Stop hooks.

## v0.51.3 — 2026-07-27

- fix: **Codex now yields only for the single bootstrap hand-off that claims a goal loop.** Once active, the goal instructions keep the turn open for ordinary builds, tests, browser work, subagents, and background tasks; they require bounded hard waits or polling rather than status-only turn endings that consume gate evaluations.
- feat: **recover an active loop whose stall counter was consumed by excess yields.** `cancel.sh reset-stall` (alias `reset-yield`) clears only repetition accounting and records the reset. It leaves criteria, evidence, ownership, iteration, status, and completion untouched; it is owner-protected and cannot revive a terminal loop.
- fix: **restart after a stalled run no longer mistakes state-machine output for SPEC-mirror drift.** Mirror and verification exclude only runtime state (`state/`, event/signing files, and task/transcript journals) while continuing to reject drift in canonical specification artefacts and ordinary source-authored journals.
- fix: **pre-push lint no longer races the S9 SDK-boundary test fixture.** The temporary violation file is excluded from broad linting, while the targeted test explicitly lints it with ignores disabled.
- fix: **every active goal-gate refusal now tells the agent to keep the turn open.** The injected Stop-hook message directs it to hard-wait or poll ordinary command, browser, subagent, and background work instead of emitting status-only yields that re-trigger the gate and consume stall accounting.
- test: **the lock-concurrency regression no longer flakes under the mandatory full-suite load.** Its helper-startup allowance is realistic while the production lock timeout remains unchanged.

## v0.51.2 — 2026-07-27

- fix: **native Playwright runs now produce signed scenario evidence.** The scenario reporter consumes Playwright's lifecycle callbacks, retains the final retry result, treats expected failures as passed, and fails closed when collection is empty or the runner reports an error. Build-check completion now carries the actual process exit code into verification, so a failed build cannot be recorded as success.
- fix: **goal-gate proof now checks the runtime hook that is actually registered.** `pursue-goal` resolves the installer-managed gate path before comparing the proof hash, rather than comparing a checkout copy that may have diverged. An explicit `GOAL_GATE_STOP` remains an intentional override.

## v0.51.1 — 2026-07-26

- fix: **Codex can now discover the goal skills installed by the goal-gate installer.** User-level Codex skills are loaded from `~/.agents/skills`, but `install.sh place-skills codex` wrote them under `~/.codex/skills` and reported success over a directory Codex never scans. Codex placement now uses `$HOME/.agents/skills` independently of `$CODEX_HOME`, including custom config-home and fixture-home cases.
- fix: **a trusted, firing Codex Stop hook now satisfies `install.sh prove codex`.** Proof recording ran before the Stop payload was parsed and tried to identify Codex from optional `CODEX_HOME`, `CODEX_SANDBOX`, or `AI_AGENT` environment variables. Codex does not guarantee those variables to hook commands, so the real fire was discarded as `unknown` even while `/hooks` correctly showed the hook as trusted. Recording now uses the authoritative parsed payload (`turn_id`) before any workstream is resolved or evaluated.
- fix: **`NOT PROVEN` no longer falsely means “UNTRUSTED.”** The diagnostic now distinguishes exact-definition trust, session reload, disabled hooks or managed-only policy, and hook load/execution errors. Proof hashes the executable implementation independently of Codex's trust in the configured hook definition; an implementation upgrade makes behavioral proof stale without claiming Codex withdrew trust.
- test: regression coverage exercises Codex payload proof with every optional agent environment variable removed, the documented `~/.agents/skills` discovery path, custom `$CODEX_HOME`, and non-misleading recovery diagnostics. Full goal-gate quality gate: 29 suites, 1618 tests, 0 failures; 86 shell files clean under `shellcheck` and `bash -n`.

## v0.51.0 — 2026-07-25

**The goal loop no longer dies in silence.** If you have ever watched a `pursue-goal` run simply stop — the agent ends its turn, nothing is finished, and nothing says why — this release is that bug.

- feat: **every way the loop ENDS is now reported to you on screen.** A Stop hook has two audiences and the gate was only using one: `decision`/`reason` are delivered to the *model* and are never displayed to the user, while `systemMessage` is displayed to the user and never seen by the model. So a stall, a flap, the recursion bound, a raised `LOOP_BLOCKED`, a bystander standing down — and completion itself — all reported to stderr, which the host files as a diagnostic. The loop ended and you saw a turn finish. Each of those paths now carries a `systemMessage`, which explains the ending without holding the turn (only a `decision` can do that, and these carry none).
- fix: **stall detection no longer kills agents that are working.** It hashed the acceptance criteria file and nothing else, so "no change" meant "no criterion was ticked this turn" — and a single large criterion takes more turns than that, during which the agent writes code, runs tests and commits while ticking nothing. Five such turns were indistinguishable from five turns of idleness. The fingerprint now includes the repository itself (committed HEAD plus a digest of the working tree), so any real work counts as progress. Where git is unavailable the checklist hash stands alone, exactly as before.
- change: **the stall threshold WARNS; the loop ends at twice the threshold.** Reaching it escalates the refusal — naming the repetition to the model and to you, and pointing at `LOOP_BLOCKED`/`WAIT` if something external is genuinely in the way — rather than ending the run on first sight. The default threshold moves from 5 to 8. Killing a loop that would have recovered costs the whole run; giving it N more turns costs N turns.
- feat: **`cancel.sh adopt` — hand a running loop to this conversation.** The gate binds a loop to the conversation that claimed it, so a resumed or restarted session is a *stranger* to the loop it started: it stands down every turn, the goal sits still, and the only previous recovery was to outwait the 900s liveness window with nothing indicating that waiting was the remedy. `adopt` releases the claim; the next turn end in your conversation picks it up through the same atomic path a fresh loop uses. Nothing about the goal changes — outstanding criteria stay outstanding, and a loop that has already ENDED is refused rather than revived.
- fix: **a finished goal no longer captures unrelated sessions.** A completed or cancelled workstream keeps its claim and heartbeat, so once that heartbeat aged past the liveness window the next session in the repository RECLAIMED the dead loop and was then held to acceptance criteria it had never heard of, for a goal that was already complete. A workstream that has ended is now last-resort for its own owner and is never adopted by anybody else.
- fix: **`pursue-goal` can restart in the same session.** After a stall it wrote a fresh workstream, but the old terminal one — still claimed by that conversation — won the binding and re-terminated immediately, so the restarted loop died on its first turn while appearing to have started.
- fix: **a heartbeatless claim is no longer stolen the instant it appears.** A claim is `mkdir` followed by two writes, so a healthy claim is momentarily heartbeatless; competitors judged it abandoned in that gap and several racers each "reclaimed" a live claim. Staleness for a claim with no heartbeat is now judged by the age of the claim directory (`GOAL_GATE_CLAIM_GRACE`, default 30s). A genuinely abandoned part-built claim is still reclaimable.
- fix: **the installer will not register a gate it cannot run.** `merge-hooks.py` checked only that `goal-gate-stop.sh` existed, but the registration is a bare path the host executes — a present-but-non-executable gate is a non-blocking hook error at *every* turn end, so the turn ends, nothing is gated, and the registration looks correct in `settings.json`. Executability is now required, and the registration pins `timeout: 120` to match the gate's own decision budget (the host default is 600s).
- fix: repaired `tests/test-payload.sh`, red since v0.50.0 (81 passed / 80 failed). That release made the gate passive where no goal is being pursued, and this suite's fixture built a gate directory with no `ACs.md` — so every case hit the new stand-down and payload handling (identity binding, agent detection, the derived key, hostile fields) went unmonitored. 161/161.
- note: **Codex users must re-prove the hook after upgrading.** Codex persists hook trust as a hash *of the hook*, so changing `goal-gate-stop.sh` silently untrusts it — a registered, correct, executable gate that governs nothing. Run `bash {skills-root}/eque2-code-goal-gate/install.sh prove codex` once after updating.

Full gate: 29 suites, 1613 tests, 0 failures.

## v0.50.1 — 2026-07-24

- fix: **the anti-tamper deny rules for evidence and state files now actually fire.** The installer (`merge-deny-rules.py`) shipped `Write(evidence/*.json)`, `Write(**/evidence/*.json)`, `Write(**/state/events.jsonl)` and `Write(**/state/HEAD.json)` alongside their `Edit(...)` twins — but Claude Code's file permission checks only match `Edit(path)` (which already covers Write, Edit and NotebookEdit), so every `Write(...)` deny rule was a silent no-op. The dead rules are dropped, and re-running `/eque2-code-setup` now purges them from an existing `.claude/settings.json`. The `Edit(...)` rules that do the real work are unchanged. New guard test (`test_no_write_deny_rules_in_tracked_settings`) fails the suite if any tracked `settings.json` deny array reintroduces a `Write(...)` form.

## v0.50.0 — 2026-07-23

- feat: **`mirror-spec.sh` mirrors multi-epic goals.** A goal with more than one canonical source (one `_bmad-output/features/<slug>/` per epic) can now be mirrored with the labelled form `mirror <goal> <slug>=<dir> [<slug>=<dir> …]`: each source lands under its own `spec/<slug>/` subtree, the manifest records one `**Source \`slug\`:**` block per epic, and `verify` drift-checks each subtree against its own source (both directions), naming the offending subtree. The single-source form (`mirror <goal> <dir>`, one `**Source:**` line, flat `spec/`) is unchanged. Mixed source forms, duplicate slugs, path-traversal slugs, and a manifest carrying both styles are all refused. Fixes the goal-gate rejecting a legitimate two-epic goal folder (`mirror-spec exit 2 — the manifest records no source path`), which previously forced hand-authoring a manifest the tool could not read back.
- fix: **the goal-gate stop hook is PASSIVE when no goal is being pursued.** A conversation that claimed no `_anon-*` workstream and has no acceptance checklist where it stands now STANDS DOWN silently and writes nothing — instead of self-binding a `<identity>.state` and REFUSING every turn, citing a repo-root `ACs.md` that was never meant to exist. So an ordinary session in a repository that merely contains a `.goal-gate/` (e.g. left behind by a finished goal) is no longer blocked with a spurious message on every turn. What remains enforced is untouched: a raised `LOOP_BLOCKED` is always brought to a reported end; the OWNER driving a loop is still gated on its real criteria; a bystander to a live loop still stands down naming the owner; and an abandoned loop is still recovered by stale-reclaim. The removed self-bind guarded only against an agent "resetting its session id" to dodge a live goal — a bypass that does not exist, since an agent cannot rewrite the host-issued session_id.

## v0.49.3 — 2026-07-23

- fix: **the goal-gate's state is resolved STRICTLY at the repo root.** The stop hook (`goal-gate-stop.sh`) and `cancel.sh` located the gate directory by walking UP from the session's working directory all the way to `$HOME`, so a `.goal-gate/` on any shared ancestor governed every repository beneath it and pooled unrelated workstreams into one store — a session in one tree could adopt another tree's goal loop and be refused on acceptance criteria it never signed up for (the "stop nudge bleeding across workstreams" symptom, with several `_anon` workstreams piling up in a single run-log). Both read-side resolvers now anchor at `git rev-parse --show-toplevel` (with the working directory as the fallback outside a repo), exactly as `pursue-goal.sh`'s write-side `pg_anchor` already did — so a gate governs one repository, only via that repository's own root `.goal-gate/`, and never an ancestor. `GOAL_GATE_DIR` remains an explicit override for tests/CI. Walk-up tests rewritten to pin the new rule (a root marker governs a nested sub-dir; an ancestor marker does not govern a child repo); full gate 1579/1579.

## v0.49.2 — 2026-07-22

- fix: **the committed keyring is always resolved at the git top level.** Pre-flight and the key-layer verifier trusted whatever project root they were pointed at, so running either from a sub-folder (a nested install, a monorepo package dir) reported a false "keyring absent" blocker while the real `state/integrity-key.json` sat healthy at the repo root — sending sessions chasing a missing key that was never missing, and one step away from minting a redundant second keyring in the sub-folder. `preflight-check.py` (keyring check + signed-history scan) and `verify-integrity-key.ts` now climb to `git rev-parse --show-toplevel` first, matching how `state.mjs` already resolved. Falls back to the passed path when git is unavailable or the directory is outside a work tree (greenfield / non-git), so the greenfield and env-override paths are unchanged. New regression test covers the sub-folder case; preflight suite 22/22.

## v0.49.1 — 2026-07-22

- docs: **the install instructions now show one command, not two.** The README opened with a fork — a Claude Code block and a Codex block, side by side, with the runtime choice made before anything else was explained — and readers copied whichever they landed on first, which on a dual-runtime repo is how `--tools` silently prunes the other runtime's skills root. It now leads with the `--tools claude-code` command alone, then explains Codex underneath: add `,codex` for both runtimes side by side, or `--tools codex` for a Codex-only project. The destructive-prune warning stays, immediately below the Codex paragraph where it applies. Same change in the per-module block and the Updating section.
- docs: the README install-block **generator** carries the same single-block layout, so `/eq2-build-marketplace` no longer regenerates the old two-block fork over a hand-fixed README. Its suite passes 9/9.

## v0.49.0 — 2026-07-21

**The gate now follows the loop, not the working tree.** This reverses the position taken in v0.48.3; if you upgraded for that release's bystander fix, this supersedes it.

- change: **a session that is not driving the goal loop stands down — its turn is no longer held.** Since v0.48.3 the gate refused *any* conversation ending a turn in a tree where another conversation owned a live loop, on the reasoning that session identity is trivially resettable and a second session would otherwise be a bypass. In practice that held unrelated work hostage daily, and it stranded the loop's own driver whenever its session identity changed underneath it — refused, in a loop it started, by a message naming a conversation that no longer existed. The predecessor stop hook scoped to the session and did not have this problem.
- The bypass that refusal guarded against is narrower than it looked. A bystander cannot write a completion record, cannot mark any criterion met, and never touches the owner's state file. The most it can do is end its own turn, which establishes nothing about the goal — the owner stays blocked on its real criteria until they are met and evidenced, and that is where the guarantee has always lived. Standing down emits **nothing on stdout**: it is the absence of a verdict, not a permit.
- unchanged, and pinned by the suites: the **owner** is still gated on its real criteria, before and after a bystander passes through; a **stale** owner is still reclaimed by the pass that runs first, so abandonment is handled by takeover and never by blocking bystanders; an **unowned** `.goal-gate/` still refuses, because that is a goal nobody is driving.
- test: `test-bystander.sh` and `test-binding.sh` §9 rewritten around the real invariant. The old §9 assertion conflated "not a completion" with "a refusal" and so could not express a stand-down; it now asserts that no binding outcome ever *permits*, that a bystander emits no verdict in either direction, and that the owner is still gated afterwards. Verified against a full clean gate: **1578 assertions, 29 suites, 0 failures**.

## v0.48.5 — 2026-07-21

- fix: **a goal's documents must live in the goal folder, and that is now enforced.** `goal-folder.md` §2 already said no artefact produced for a workstream may be written outside `X.goal/`, with the SPEC as the single named exception — the create-spec pipeline owns its output path, so prepare-goal mirrors the result into `X.goal/spec/` with `MANIFEST.md` recording provenance. That mirror was instructed in prose and enforced by nothing, so a run could invoke the spec pipeline, leave `spec.md` in the pipeline's own output directory, and finish with a folder that was not self-contained. Observed in the field. `pursue-goal` now refuses to start against a folder whose mirror does not verify: `spec/` with no `MANIFEST.md` (a mirror without provenance), a manifest whose source has vanished, or a mirror that has drifted from it. Every refusal writes no loop state.
- fix: a folder carrying neither `spec/` nor `MANIFEST.md` is **reported loudly, not refused** — "no spec was ever produced" and "a spec was produced elsewhere" are not distinguishable from the starter, and refusing would strand goal folders prepared before this check existed.
- docs: the mirror step in Phase 2 is now marked non-optional and carries its own `mirror-spec.sh verify` call, so a run catches an unmirrored spec itself rather than leaving it for the next session's starter to find.

## v0.48.4 — 2026-07-20

- chore: the predecessor loop mechanism is no longer named anywhere in the shipped surface. 26 prose references removed from the gate, the installer and the test commentary; the goal-gate and prepare-goal/pursue-goal docs now describe it only as "the predecessor stop hook". The detection pattern that lets `install.sh migrate --remove-predecessor` find and retire an existing registration is deliberately unchanged — it has to name what it matches on, and removing it would take away the only supported handover path for anyone still running the predecessor.

## v0.48.3 — 2026-07-20

Concurrent sessions, and where the gate actually lives. Both found in the field; the registration change also closes a fail-open the previous releases shipped.

- fix: **a second session in a tree running a goal loop is refused for the real reason.** It used to self-bind, derive an acceptance-criteria path from the gate directory's *parent*, and refuse with "no acceptance criteria file at `<repo>/ACs.md`" — naming a file that was never meant to exist. It now names the owning conversation and the ways forward. **The refusal itself is unchanged and deliberate:** the gate governs the working tree, not the session, because session identity is trivially resettable — otherwise hitting the gate and opening a second session would walk away from an unmet goal. A loop that has ENDED (cancelled, complete, stalled) no longer blocks bystanders at all, so following the advice to cancel now works immediately instead of after a liveness window.
- fix: **the hook registration no longer points inside a checkout.** Registrations are user-global for both agents, but carried a path inside whichever repository ran the installer. That meant (1) installing from a second project silently repointed the machine-wide hook at that project — observed live, with `hooks.json` naming one repo while work happened in another; and (2) under Codex, which trusts a hook *by hashing it*, every re-registration invalidated the recorded trust and the hook was silently skipped again, forever, with nothing saying it had lapsed. The gate is now placed once at a single agent-neutral location (`${XDG_DATA_HOME:-~/.local/share}/goal-gate/gate/`) that every registration shares, so trust granted once keeps holding and no project can steal another's registration. `install` places the gate before registering and refuses to register one that cannot run — a registered-but-missing hook command fails **open**.
- fix: the runtime location is now *checked* not to collide with the `.goal-gate` marker directory the gate walks up looking for. A runtime tree there makes the parent look like a bound workstream and blocks every session beneath it — which happened, and required deleting the directory by hand.
- fix: a stale `test-skills.sh` assertion pinned the pre-v0.48.2 skill name, so **v0.48.2 shipped with a red suite**. Fixed, and this release is verified against a full clean gate run: 1560 assertions, 28 suites, 0 failures.
- test: new `test-bystander.sh` (12), plus T3.1 regressions proving both agents' registrations stay byte-identical under every call shape — including agent-specific homes, where they had silently diverged.

## v0.48.2 — 2026-07-20

**v0.48.0 and v0.48.1 did not actually install the goal-oriented workflows.** Both are superseded; upgrade.

- fix: **the three goal skills now install at all.** Their frontmatter `name:` still carried the unprefixed names from the source repo (`goal-gate`, `prepare-goal`, `pursue-goal`) while their folders were `eque2-code-*`. BMad places a skill by its frontmatter name, so all three were stranded under `_bmad/eque2-code/` and never became invocable — silently, while the install reported success. Confirmed against a real 0.48.1 install: all 20 skills with `name` == folder landed in the skills root; the 3 with a mismatch did not. They are invoked as `/eque2-code-prepare-goal`, `/eque2-code-pursue-goal`, `/eque2-code-goal-gate`.
- fix: **the Stop hook no longer fails open.** Setup registered a hardcoded path without checking it existed. A Stop hook whose command is missing produces a non-blocking host error and the turn ends **with nothing gated** — silently, at every turn end, which is the precise outcome the goal gate exists to prevent. The gate is now located before registration (canonical, Codex root, and unprefixed source layouts), and when it cannot be found the hook is **not registered** and any stale registration is **removed** — pursue-goal then refuses to bind, which is the correct fail-closed behaviour. Third-party Stop hooks are never touched.
- test: a marketplace guard now fails the build when any skill's frontmatter `name:` differs from its folder, with a non-vacuity assertion so it cannot pass by inspecting an empty tree.

## v0.48.1 — 2026-07-20

Two install-time failure modes reported from the field, both of which failed *silently*.

- fix: **a downgrade is now detected and reported.** Setup treated any version difference as an upgrade, so installing an OLDER version computed a changelog delta from new→old, found it empty, printed nothing, and the install looked clean. The usual cause is `npx bmad-method install` reusing a **cached** copy of the custom source instead of fetching the requested `?ref=`, so a pinned install quietly lands the previous release. Setup now compares semantically (`sort -V`) and surfaces a downgrade loudly, naming the stale-cache cause.
- docs: **`--tools` is destructive to the runtime you leave out**, and the install instructions now say so above the commands rather than implying it in passing. The installer treats the named tools as the complete set and prunes the other runtime's skills root — on a dual repo, `--tools claude-code` deletes `.agents/skills/` outright (thousands of tracked files, no prompt). Includes the pre-flight check and the `git restore` recovery line. This is a documentation fix only: the pruning is `bmad-method` installer behaviour and cannot be changed from this repo.
- docs: the README now carries the pinned-`?ref=` install form at all — it previously showed only floating installs — plus the instruction to verify `_bmad/eque2-code/.version` against the tag you asked for after any pinned install.

## v0.48.0 — 2026-07-20

Goal-oriented workflows — `[PG]` prepare-goal is replaced, and two new commands join it. Imported from the `jam-flow` prototype, where the gate was proven live under both agents.

- **breaking: `[PG]` prepare-goal is a different command.** It no longer emits a charter document; it produces a self-contained `X.goal/` **folder** — hardened charter (`goal.md`), an acceptance contract (`ACs.md`), the real SPEC produced during the run via the evidence-gated `[CS]` pipeline, a journal, and a review report. It prepares only; it does not execute the charter. Existing charters from the old `[PG]` are unaffected but nothing consumes them.
- feat: `[PU]` pursue-goal — binds a prepared `X.goal/` folder and yields. From then on a `Stop` hook runs at every turn end and **refuses to let the session finish** while any acceptance criterion is outstanding, or ticked without evidence. The governing rule throughout is fail-closed: any unknown, error, or check that could not run resolves to "not done" and refuses. A check that did not run is never a pass.
- feat: `[GG]` goal-gate — inspect or cancel a loop that is already running. Cancelling is a reported end, never a completion: unmet criteria stay unmet and nothing is ticked.
- feat: `/eque2-code-setup` registers the gate — a fourth `Stop` hook registration via `merge-hooks.py` on Claude Code, and `$CODEX_HOME/hooks.json` on Codex. Idempotent, additive, third-party hooks preserved.
- feat: **proof-of-fire for Codex.** Codex gates hook execution on persisted trust and silently skips an untrusted hook — clean exit, no warning, gate completely inert — so a written registration is not evidence of anything, and `doctor` cannot tell the difference. The gate now records that it actually ran, and `pursue-goal` refuses to bind a loop under Codex until it has been observed to do so. Establish it once per machine with `install.sh prove codex`. Because Codex trusts a hook **by its hash**, every release of the gate silently withdraws that trust: the proof goes stale on upgrade by design and `prove` is re-run once. Claude Code has no trust layer and requires none of this.
- 28 hermetic test suites ship with the skill (`eque2-code-goal-gate/tests/run-all.sh`), including the new `test-proof-of-fire.sh`. Run them serially — they contend concurrently — and note the suite loop reads its worklist from a here-doc, so suites run with stdin from `/dev/null`.

**Migration notes (existing installs):** re-run the pinned install + `/eque2-code-setup` to land the three skills and the gate registration. Codex users must additionally run `install.sh prove codex` once; until they do, `pursue-goal` refuses to start rather than run ungated.

## v0.47.0 — 2026-07-16

Verifier-only minting — policy-first role separation for the test-verdict mint path (incident CMC-32874: an orchestrator "probe" of `tests-cli verdict` minted a terminal `verified_passing`).

- feat: the tests CLI's mint verbs fail closed — `verdict` requires a live verifier role marker (`.eque2-tests/state/.verifier-marker.json`, written by the harness hooks, never by any agent); `verdict --verdict=lease` binds the marker's nonce into the lease; pass/fail verdicts require that nonce-bound lease. Refusals are structured JSON (`{refused, reason, stateUnchanged, hint}`) naming the exact gate (missing-marker / expired-marker / malformed-marker / nonce-mismatch / missing-flags / admin-gate), exit 2, zero state change — replaying the literal incident command is refused at the marker gate before testId resolution.
- feat: role attribution — every verdict event carries the minting role + nonce inside the signed event; an explicit era-boundary event is recorded; wrong-role or post-boundary role-absent mints are flagged `role_violation` at read (readable, never cascaded into tamper rejection), surfaced in `summary` (`mintRoles`, `roleViolations`, `trustedVerified`), and excluded from trusted counts. Pre-boundary events verify clean.
- feat: named subagents — `eque2-verifier` (the ONLY verification dispatch type; SubagentStart/Stop hooks mint/revoke its role marker, nonce-scoped) and `eque2-builder` (carries an unconditional mint-verb deny hook; terminal verb BUILD_COMPLETE). Grace/backfill/develop-spec dispatch converts to the named types.
- feat: session-wide marker-aware PreToolUse hook denies mint verbs whenever no verifier is running — the orchestrator's point-of-action friction layer; denials append to `.eque2-tests/state/policy-denials.log` with both policy clauses + the incident named.
- feat: `retract` verb — admin-gated (`EQUE2_TESTS_ADMIN=1`), append-only supersede: `verified_passing` → `awaiting_verification`, original mint stays in history, double-retract safe (`stateChanged: false`).
- feat: `verification-reset` reports truthfully (`leasesCleared`, `verifiedPassingUntouched: true`, leases-only wording, retraction hint) and skips a lease whose verifier marker is still live; now a structured admin-gate refusal (exit 2) without `EQUE2_TESTS_ADMIN=1`.
- feat: sanctioned hookless runner (`scripts/verification-runner.py -- <verifier command>`) mints/revokes the marker for Codex/headless runtimes — CLI behaviour identical.
- feat: `--help` on every mint verb prints the role policy (Clauses A + B); canonical clause text ships in `assets/policy-clauses.md` and is audit-enforced across all policy carriers.
- feat: `/eque2-code-setup` installs the subagent definitions, the three hook registrations (`merge-hooks.py`, idempotent), and the marker/denial-log gitignore entries; `preflight-check.py` fails NAMED on claude-code < 2.1.195 (SubagentStart matchers) and emits an informational runner-fallback skip on no-`claude` installs.
- feat: admin-gated canary affordance `verdict --force-role=<role>` (honestly self-labelled wrong-role mint, flagged at read) powers the rogue-builder canary (`scripts/dev/rogue-builder-canary.sh` in the source repo) — hook-denial, marker-gate refusal, role_violation flagging, and retraction proven in a real disposable repo before every release.

**Migration notes (existing installs):** era-gated and data-migration-free — old envelopes (no nonce) and pre-boundary events verify clean. Re-run the pinned install + `/eque2-code-setup` to land the subagent definitions and hooks; until then the CLI gates alone hold (verification through the sanctioned runner). In-flight leases taken before the upgrade refuse new-CLI mints with `nonce-mismatch` — let them expire (30-min TTL) and re-lease.

## v0.46.1 — 2026-07-15

- feat: dual-runtime install is first-class — `npx bmad-method install --tools claude-code,codex` populates both skills roots, and setup now detects `dual` mode and writes BOTH surface sets: all Claude surfaces (deny rules, CLAUDE.md clause, startup rule) AND the Codex `AGENTS.md` bridge block. Previously a dual install configured Claude only, leaving Codex without its discovery bridge.
- ci: third install-flow lane exercises the dual install end-to-end (both roots present, both surface sets written, operator sentinels preserved)

## v0.46.0 — 2026-07-15

Codex publishing support — eque2-code now installs and runs on both Claude Code and Codex.

- feat: Codex runtime support — install with `npx bmad-method install --custom-source … --tools codex`; skills land at `.agents/skills/` and every Eque2 CLI path resolves from either root via the new `{skills-root}` token (each SKILL.md defines it; resolver: whichever skills root contains `eque2-code-setup/`)
- feat: platform-aware setup — detects the runtime structurally; on Codex it merges a discovery + anti-tamper bridge block into the target repo's `AGENTS.md` (new `merge-agents-md.py`, idempotent managed block, existing operator content preserved) and writes **no** `.claude/` files (no settings deny rules, no CLAUDE.md clause, no startup rule)
- feat: `state health` no longer requires the `claude` binary — the `claudeWorker` check reports a truthful degraded pass (`ok: true, degraded: true`, plus a top-level `degraded` flag) when the CLI is absent; setting `CLAUDE_BIN` explicitly still asserts presence (unspawnable → RED)
- fix: empty `CLAUDE_BIN` env (`CLAUDE_BIN=`) is treated as unset instead of crashing the probe; `probeClaude` never throws on an invalid binary path
- feat: README, marketplace metadata, and the publish confirmation advertise both runtimes; CI install-flow now runs a claude-code × codex matrix (expected skill root, platform-file assertions, AGENTS.md/CLAUDE.md preservation, claude-less health)
- docs: maintainer pipeline direct-script entry points for Codex maintainers (`docs/maintainers-codex.md`)

**Migration notes (existing installs):**
- Claude Code installs are unchanged — the resolver prefers `.claude/skills` and all Claude-only surfaces still install exactly as before. Re-run the pinned install + `/eque2-code-setup` to pick up the tokenised skills.
- Skill prose now references `{skills-root}` instead of hard-coded `.claude/skills` paths — custom automation that grepped for literal `.claude/skills` invocation lines in skill files should resolve the token instead.
- Codex adopters: install with `--tools codex`, then run the setup skill (`.agents/skills/eque2-code-setup/SKILL.md`) — it merges the AGENTS.md bridge block Codex uses to discover Linus/Grace and the bundled CLIs.

## v0.45.1 — 2026-07-13

Field fixes from the first v0.45.0 installs over a pre-v0.45 (encrypted-blob era) repo.

- fix: `ensure-gitignore.py` now ignores `.signer-key` — the per-spec plaintext Ed25519 verdict
  signing key was committable because the managed block never listed it (SKILL.md required it).
  A new test suite pins SKILL.md ↔ script parity via real `git check-ignore`.
- fix: the setup key-verify step's legacy-blob guidance is context-aware instead of an
  unconditional "run key migrate": with the keyring already committed it says the blob is stale;
  with signed history it routes migration to the blob committer's machine (named via `git log` —
  their OS keychain holds the decrypted key, no age tooling needed); on a greenfield checkout it
  sweeps ALL fetched refs for signed history before trusting "greenfield" and gives coordinated
  bootstrap guidance instead of two contradictory instructions.
- fix: `key migrate` no longer dead-ends a non-recipient on an unreadable legacy blob when
  nothing is signed — new named exit 18 `stale-blob-no-history` names the blob's committer and
  routes to `key init`; the exit-13 remedy no longer demands an age identity.
- feat: the setup migration step now sweeps stale legacy encrypted-key artifacts (the blob and
  its recipients config) — guarded: only after the committed keyring exists AND is git-tracked,
  and a recipients config that doesn't reference integrity-key is left alone.
- docs: SKILL.md and key-onboarding.md now cover the upgrade-over-legacy-install topology,
  including who holds the legacy key and when `key init` is safe.

## v0.45.0 — 2026-07-10

The shared integrity key is now **committed to the repo in plaintext** (`state/integrity-key.json`)
and protected by the same agent-facing policy that protects all other evidence — no age, no sops,
no keychain, no mint helper, no onboarding, for either agent. The seal still structurally prevents
silent tampering; the key's secrecy was never a real defence against a same-machine agent and is
no longer pretended to be.

- feat: committed plaintext keyring `{projectRoot}/state/integrity-key.json` is the default key
  source for every CLI — clone the repo and the key is there; env `INTEGRITY_KEY(S)` becomes an
  exceptional OVERLAY (env signs, the file still verifies, loud divergence warnings)
- feat: `state.mjs key init` — greenfield bootstrap (collision-resistant keyId, atomic write,
  printed commit instruction); refuses over existing signed history
- feat: `state.mjs key migrate` — moves a legacy key (old keychain entry / encrypted blob / env)
  into the committed file: same key material, keyIds discovered by verifying committed history,
  idempotent, atomic, never deletes the source, refuses success until the file is git-tracked,
  named exit code per refusal cell; the only legacy-source read lives in a separate non-bundled
  sanctioned script (flagged for removal in a later release)
- feat: `state.mjs health` gains a key-provenance check (source, file path, git-tracked status,
  activeKeyId, referenced-but-absent keyIds, events verified)
- feat: setup's key step is a three-case detection (present → verify / absent-with-history →
  broken-clone BLOCKER / greenfield → guided init) with JSON stdout + prose stderr
- feat: evidence + snapshot integrity consolidated onto the committed keyring with explicit
  keyIds; per-spec `.evidence-key` files are no longer created (legacy folders stay readable,
  reporting `legacy-unverifiable` — never a false "tamper" — when their era key is absent)
- feat: the verdict signer private key is a plaintext `{specFolder}/.signer-key` (gitignored,
  policy-protected); the `eque2-code-signer` keychain service and mint helper are gone
- removed: SOPS/age onboarding (recipient dance, blob decryption, `integrity-key.sh`), the
  `eque2-code-state` keychain master-key bootstrap, and the keychain integrity-key hydration —
  a fresh clone works with zero key steps; CI needs no key secret
- fixed: seal-failure diagnostics now distinguish rotation-gap / tamper / keyring-malformed /
  legacy-unverifiable, with `git pull` / `key init` / `key migrate` remedies
- security/honesty: the pinned anti-tamper clause on all policy surfaces names the committed
  keyring and states the policy-over-secrecy trade plainly (deterrence, not prevention); deny
  rules cover reading the keyring; the reporter's silent-unsigned evidence fallback is removed
  (a missing key fails the write loudly)

Upgrade notes: existing installs run `node state.mjs key migrate` once (on a machine holding the
legacy key), commit `state/integrity-key.json`, and every teammate/CI just pulls. Legacy keychain
entries and blobs are left in place for you to delete after confirming the commit.


All notable changes to the `eque2-code` module. The version on the latest entry matches `assets/module.yaml`'s `module_version:`.

## v0.44.4 — 2026-07-09

Closes the remaining items from the `media-player-queueing-closure` field report (`eque2-issues.md`, eque2-code v0.44.1).

**Feature — consolidated scenario test files are now first-class (issue #7).** A natural TDD build consolidates related scenarios into one spec file, but the 1:1 scenario→`testFile` mapping from `definitions.json` reported every absorbed scenario's per-scenario file as missing, forcing a large mechanical phase that duplicated coverage already written.

- **Feature** — new `set-testfile` state CLI verb: `node state.mjs <spec> set-testfile S3 <consolidated-file> --reason "..."` repoints an absorbed scenario's `testFile` at the consolidated file. The target must exist; the change is journaled. Structural verification (source hash, evidence, Gherkin coverage) then resolves against the file that actually holds the assertions.
- **Feature** — the vitest scenario-state-reporter now scans test titles for `[S{N}]` tags (same id vocabulary as the filename router): one consolidated run emits separate HMAC-signed evidence per tagged scenario — the primary (filename) scenario keeps all tests, each tagged scenario gets exactly its tagged tests.
- `verify-scenario/SKILL.md` now instructs the verify subagent to check for a covering sibling spec BEFORE creating a per-scenario file, and to tag + repoint instead of duplicating coverage. `state-cli-reference.md` documents the full flow.
- Tests: end-to-end repoint → evidence → `verified` drain, per-scenario evidence bucketing, tag-vocabulary bounds.

**Feature — large-task in-session build gate (issue #5).** Three successive `[DS]` build subagents went silent for 8–64 minutes mid-read of an 865-line source + 1955-line spec and produced zero output; tighter prompts, design docs, and line-range pointers did not help, and each circuit-breaker detection cost ~20 minutes. `develop-spec/references/execute.md` now sizes build tasks before delegating: over ~1500 total lines (or any single file over ~800), the orchestrator builds in-session — same TDD flow, same state CLI calls — while review and verify still go to fresh sibling subagents (the anti-bias guarantee lives there, not in the builder).

**Fix — verify-scenario pointed at a non-existent reporter path (issue #6).** `verify-scenario/SKILL.md` told the verify subagent to load the vitest reporter from `_bmad/eque2-code/scripts/scenario-state-reporter.js`, which does not exist in an installed repo — a subagent following the doc literally fell back to the weaker no-evidence path. Corrected to the real shipped path: `.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs`.

**Fix — `[CS]` TEST_DIR resolution hardened (issue #3 follow-through).** The v0.44.3 regex fix made the `context.md` strategy work; Stage 3 of create-spec now also runs the resolver AFTER `context.md` is written (previously it ran before the file existed, so the highest-confidence strategy was dead on first pass), and any non-`context_file` resolution is treated as low-confidence and cross-checked against the files-to-modify table before being stored.

**Docs — residual `state.ts`/`npx tsx`/Docker/MCP/restart references purged (issues #1/#2).** develop-spec skills, the setup skill (including its `npx tsx` fallback, removed — target repos ship only the compiled `.mjs` and `npx tsx` is known to hang), the shipped startup rule, and the repo README (no Docker prerequisite, no MCP registration, no restart step — there is nothing to re-register).

## v0.44.3 — 2026-07-09

**Fix — `state.mjs status` cross-checked task/scenario/build-check IDs against `spec.md` alone.** Field report from a `[DS]` run: `state.mjs <feat> status` emitted a spurious `"<id> in state/ but not in spec.md"` warning for every single actor. Root cause: `[CS]` Stage 6/7 write task IDs (`T1.1`) into `tasks.md` and scenario/build-check IDs (`S1`, `BUILD-1`) into `scenarios.gherkin` — never into `spec.md` itself — so the ADR-10 consistency check, which only scanned `spec.md`, always came up empty and flagged every actor as orphaned even though the build and structural verification were both healthy. Log noise only; no functional impact.

- **Fix** — `cmdStatus`'s spec-doc consistency check now scans `spec.md` + `tasks.md` + `scenarios.gherkin` together, matching where `[CS]` actually authors each ID class.

**Fix — `[CS]`'s TEST_DIR resolver missed markdown-decorated hint lines.** `.test-dir.json` recorded the wrong `TEST_DIR` for a workstream whose `context.md` used the LLM-typical `- **TEST_DIR:** \`apps/ui/src/components/media-player\`` form — the old regex only matched a bare `TEST_DIR: <value>` line, so it silently fell through to the generic `common_pattern`/`find_match` heuristics and picked an unrelated directory. Benign only when scenario `testFile`s carry an explicit path that overrides the bad default; would bite a workstream relying on it.

- **Fix** — `cs-resolve-test-dir.py`'s context-file strategy now recognises a leading bullet, bold key markers, and backtick-wrapped values around `TEST_DIR`/`Test directory`, in addition to the bare form.

**Fix — stale `npx tsx` invocations across skill docs hung on this machine's ambient Node.** `develop-spec`, `setup`, `create-spec`, `jira-fetch`, `agent-grace`, `backfill`, `e2e-test`, `fetch-tests`, `test-report`, `test-setup`, `test-status`, `update-status`, and `xray-conformance` skill docs still told the orchestrator/subagents to invoke the state/xray/tests CLIs as `npx tsx {STATE_CLI}`/`npx tsx xray-cli.ts`/`npx tsx tests-cli.ts` — a form that hangs post-Docker-removal (there is no `state.ts`/`xray-cli.ts`/`tests-cli.ts` source or MCP server in an installed target repo, only the bundled `.mjs`) and forced every spawned build subagent to have the correct invocation injected into its prompt by hand.

- **Fix** — every such invocation now reads `node {STATE_CLI}` / `node .../xray-cli.mjs` / `node .../tests-cli.mjs`, pointing directly at the bundled scripts under `.claude/skills/eque2-code-setup/scripts/`.
- **Docs** — `develop-spec`'s `{STATE_CLI}` convention is now defined explicitly in `SKILL.md` (resolves to the bundled `state.mjs` path) instead of being used undefined throughout the skill's references.
- **Docs** — renamed `develop-spec/references/mcp-reference.md` → `state-cli-reference.md`; the old name and its `state.ts CLI Reference` heading described a removed MCP transport that no longer exists.

## v0.44.2 — 2026-07-09

**Fix — `cross-keychain` lookups no longer depend on `$PATH`.** Confirmed live on a freshly-migrated (v0.44.1) install: `state.mjs`/`tests-cli.mjs` (integrity key) and the mint helper in `verdict.ts` (per-spec signer key) shelled out to `cross-keychain` as a bare command, which only resolves when the setup skill's local `node_modules/.bin` happens to be on `$PATH` — true only inside `/eque2-code-setup`'s own instructions, never for a subsequent Linus/Grace/`[CS]`/`[DS]` invocation run from a plain shell or subagent. Every such invocation failed with `No integrity key found` even though the key was genuinely present in the keychain.

- **Fix** — added `resolveCrossKeychainCli()` to `keychain-resolve.ts`, mirroring `keychain-bootstrap.ts`'s own resolution order: prefer `cross-keychain` on `$PATH`, else fall back to `../node_modules/.bin/cross-keychain` resolved relative to the running script's own location (works identically whether run as source or as the bundled `state.mjs`/`tests-cli.mjs`).
- **Fix** — `state.mjs`/`tests-cli.mjs`'s integrity-key lookup and `verdict.ts`'s signer-key read/write both route through the shared resolver instead of a bare `spawnSync("cross-keychain", ...)`.

## v0.44.1 — 2026-07-08

**Critical fix — state/tests storage silently defaulted to `/data`, the removed Docker container's bind-mount root.** Confirmed live on a freshly-migrated (v0.44.0) Docker-less install: every `state.mjs`/`tests-cli.mjs` invocation with no `STATE_DIR` override failed with `ENOENT: mkdir '/data/state/...'` — this repo has no `/data`, and even where one exists it would silently pool every project's state into one shared, un-versioned location. This blocked `migrate-remove-docker.py`'s own health-check gate (which correctly aborted the Docker volume cleanup rather than risk data loss) and every subsequent CLI-only `[DS]`/`[CS]`/Grace invocation.

- **Fix** — `state.ts`'s storage now defaults to `{specFolder}/state` when no override is set — the same place `state/events.jsonl` and Ed25519-verdict snapshots are already committed, and exactly what `state.ts init`'s own `definitions.json` read path expects. `STATE_DIR`/`STATE_DB_PATH` remain a full override for test isolation, unchanged.
- **Fix** — `tests-cli.ts`'s single project-scope storage now defaults to `{projectRoot}/.eque2-tests/state`, matching the `.eque2-tests/runs` convention `EQUE2_TESTS_LOG_DIR` already documents. `STATE_DIR`/`TESTS_DB_PATH` remain a full override.
- Neither engine's storage-root resolver falls back to a hardcoded path anymore — the previous `/data/<name>` literal only ever made sense inside the removed Docker container's bind-mounted volume.

## v0.44.0 — 2026-07-08

**Docker and all 3 MCP server registrations removed.** State, tests, and Xray now run as plain host CLI scripts — no daemon, no container, no `claude mcp add`. This is a large workstream (19 stories across 6 epics) landing in one release.

- **Feature** — state/tests/xray are now invoked directly as CLI scripts (`state.ts`/`tests-cli.ts`/`xray-cli.ts`), matching the exact verb/JSON surface the removed MCP tools exposed.
- **Feature** — the CLIs are bundled via esbuild and shipped self-contained inside the setup skill (`state.mjs`/`tests-cli.mjs`/`xray-cli.mjs`) — `node scripts/state.mjs <verb>` works fully offline immediately after a marketplace install, no local eque2-code clone required.
- **Feature** — verification now runs in fresh-context subagents spawned directly by the orchestrator (a sibling of the build subagent, never its child) instead of a persistent in-container verifier loop.
- **Feature** — host-side signing key provisioning: the CLI resolves the shared `integrityKey` from the OS keychain automatically when no env var is set, replacing the deleted Docker launch wrapper's env-injection role.
- **Feature (mint helper)** — the per-spec Ed25519 signer private key now defaults to the OS keychain (service `eque2-code-signer`) instead of a plaintext `.signer-key` file, with automatic migration for existing installs. Closes a bypass gap where a hand-written script could read a file that Bash-pattern deny rules alone couldn't fully cover.
- **Feature** — concurrency-safe CLI writes: the state/tests storage engine now serialises its `events.jsonl`/`HEAD.json` read-modify-write via an OS file lock (with stale-lock recovery), so concurrent CLI invocations — multishell, a verify subagent, parallel fan-out — can no longer interleave or lose events.
- **Feature** — every secret (`.evidence-key`, `.signer-key`, keychain reads of either service, and direct `events.jsonl`/`HEAD.json` edits) is now covered by deny rules merged into both this repo's and an installed target repo's `.claude/settings.json`.
- **Feature** — the anti-tamper/switch-off policy clause is now pinned byte-identical across all 6 named agent/policy surfaces, including a new setup-time step that merges the same clause into an installed target repo's own `.claude/CLAUDE.md`.
- **Feature** — every state folder now gets an idempotent anti-tamper `CLAUDE.md` written at `init`, stating that only the CLI/verification agent may modify its contents.
- **Fix** — `scripts/dev/install-smoke.sh` (a maintainer smoke test) was broken by the Docker removal — rewritten to exercise the CLI path, with no `docker` on PATH, ending in a real `init`→`status` round-trip.
- **Fix** — the CLIs' ESM main-guard silently no-op'd (exit 0, zero output) when invoked from a symlinked path (e.g. macOS's `/tmp` → `/private/tmp`) — now realpath-resolved before comparing.
- **Fix** — a migration script handles a prior Dockerized install: removes stale MCP registrations and Docker artifacts while preserving keychain keys and verifying committed state first; aborts before touching anything if verification fails.
- **Chore** — deleted `Dockerfile`, the in-container verifier directory, and all Docker/MCP-registration/launch-wrapper machinery.
- **Chore** — stripped Docker/state-image blockers from `preflight-check.py`.
- **Chore** — purged stale ralph-loop/Docker/MCP/SQLite prose across roughly 50 files spanning every module skill.

## v0.43.0 — 2026-07-07

[CS] + [PG] — **Exhaustive by default; no silent defer or OOS.** `create-spec` and `prepare-goal` no longer volunteer scope carve-outs. Every finding surfaced during review gets applied in the same run; the Out-of-Scope section of a spec is EMPTY unless the workflow was explicitly halted on a hard external blocker and the user approved the carve-out.

- **Change ([CS])** — `template.md`'s "Out of Scope" section is now empty by default and only accepts entries recording a halt-and-approve (unavailable env, missing creds, embargoed dep, contradiction with a frozen decision). Volunteered exclusions ("feels adjacent", "we can do this later", "nice to have") are prohibited.
- **Change ([CS])** — `SKILL.md` top-of-workflow adds a "scope-exhaustive" non-negotiable rule that every stage (including Stage 8 review triage) inherits.
- **Change ([CS])** — Stage 8 auto-invocation and `checklist.md` no longer skip nice-to-have / optimization findings. All findings apply; if a finding is genuinely orthogonal (a distinct workstream), the workflow HALTS and asks the user rather than silently dropping it.
- **Change ([PG])** — Phase 0 no longer asks "what is out of scope?" as a routine question. Exhaustive is the default; OOS is elicited only when the input names a hard blocker.
- **Change ([PG])** — Phase R triage collapses to two buckets: **Blocking** and **Should-fix**. The old "Follow-up → `followups.md`" drawer is gone; genuinely orthogonal work now requires an explicit HALT-and-approve. Silent deferral of a review finding is now a workflow failure, not an option.
- **Change ([PG])** — the SPEC "Out-of-scope list" content requirement, the "No deviation" clause's "tangents get logged as follow-ups" language, and the output-shape success criterion all rewritten to match the halt-only carve-out rule.
- **Test** — bump CAP-1 stdio-close timeout 120s → 180s so load-heavy runs pass.
- **Fix** — gitignore the S9 boundary-violation temp file instead of ESLint-ignoring it.
- **Fix** — exclude the S9 SDK boundary-violation fixture from lint.

## v0.42.12 — 2026-07-06

[DS] lint/typecheck quality gate moved from per-parent-task to once-at-completion.

- **Change** — the orchestrator-level lint/typecheck gate (`develop-spec/references/execute.md`) now runs a single full-suite pass over the whole worktree in the `done` branch of the loop, instead of after every parent-task review. Each build subagent's own diff self-lint (`subagent-prompt.md`) is unchanged. Shipped code is lint-clean either way; the per-task cadence was O(N) redundant full-suite runs.

## v0.42.11 — 2026-07-06

[DS] build subagent stall fix — in-session `develop-spec` build/verify subagents no longer report `completed` while their work is unfinished, burning a full context reload on every resume.

- **Fix** — the Task subagent prompt (`develop-spec/references/subagent-prompt.md`) now carries an explicit **EXECUTION MODE** rule: run every build/test/gate/commit command in the foreground within the turn, never `run_in_background` or a detached waiter. For a Task subagent, backgrounding-and-waiting *ends the turn*, so the runtime marks it complete before the task finishes; the guardrail timeouts (120s zero-output kill, 180s cap) were pushing the model into that pattern for `nx`/`vitest`/`tsc` commands that actually finish in seconds. Foreground-only removes the stall (headless [DS] was never affected — it runs inline, with no async-subagent turn boundary).

## v0.42.10 — 2026-07-06

Git-worktree coexistence — you can now run eque2-code in a linked worktree **and** its main checkout at the same time, each isolated to its own state store. v0.42.9 made the mis-mount self-diagnosing but its remedy ("register the worktree, restart") didn't actually work: Claude Code collapses a worktree's `--scope local` MCP registration onto the main checkout (shared `.git` common-dir), so per-worktree re-registration is silently discarded.

- **Fix** — the state and tests launch wrappers now **self-heal to the worktree at launch**. Even when a worktree session loads the main checkout's wrapper, the spawned MCP process cwd is the worktree, so the wrapper resolves the project root from `git rev-parse --show-toplevel` and — when that cwd is a *sibling worktree* of the registered root (verified by an inode-level `git --git-common-dir` match, so an unrelated repo that merely happens to be the cwd never hijacks it) — mounts the worktree, rebasing a baked `EQUE2_FEATURES_PATH` onto it too. One registration in any checkout now drives every worktree, each on its own hash-keyed volume/keychain.
- **Fix** — session startup now checks whether a worktree's **encrypted volume + keychain key** are bootstrapped (rather than whether it has its own registration, which it never gets) and prompts `/eque2-code-setup` only when that store is missing — no restart needed.
- **Docs** — `/eque2-code-setup` now explains the collapse-and-self-heal model and corrects the false "each worktree gets its own registration" claim from v0.42.9.

## v0.42.9 — 2026-07-05

Git-worktree fix — using eque2-code from a git worktree no longer strands you on an opaque "Spec folder not found". A worktree is a separate working dir sharing one `.git`, so setup run in the main checkout never registered anything for it; the previous symptom was silent (tools missing, or wired to the sibling checkout).

- **Fix** — the in-container state server now reports the **root it actually mounted** when a `specFolder` resolves outside it. Instead of a bare "Spec folder not found: …", the error names the mounted project root and points at the likely cause: a git worktree (or sibling checkout) whose eque2-code MCP was never registered against it, with the remedy (run `/eque2-code-setup` there, restart). The launcher passes `EQUE2_PROJECT_ROOT` into the container so the server can name the mount.
- **Feat** — session startup now **detects a git worktree with no eque2-code registration of its own** and tells you to run `/eque2-code-setup` in it (each worktree gets its own registration, keyed by path — the main checkout's is untouched).
- **Docs** — `/eque2-code-setup` documents that registration is per-worktree and why.

## v0.42.8 — 2026-07-05

Multi-project fix — the `eque2-code` MCP servers can now run in several repos at the same time. Previously, opening a second project disconnected its state server ("the eque2-code-state MCP server is wired to a sibling project, not this repo").

- **Fix (blocker)** — `/eque2-code-setup` now registers all three MCP servers (`eque2-code-state`, `eque2-xray`, `eque2-tests`) at **`--scope local`** (per-project, keyed to the project directory) instead of `--scope user` (one global entry). The global registration pinned every repo on the machine to whichever project ran setup last, so a second open repo saw its state server wired to a sibling project and disconnected. The runtime was already fully per-repo (per-project Docker volume `eque2-state-<hash>` + per-project keychain key, no fixed container `--name`); only the registration scope was global. The `claude mcp add` now runs from `$PROJECT_ROOT` so the entry lands under the exact project key the interactive session reads, and any pre-existing `--scope user` entry is removed on setup as legacy cleanup.
- **Migration** — existing installs must **re-run `/eque2-code-setup` in each repo and restart Claude Code**. The first re-run removes the shared global `--scope user` entry for every repo; each re-run then registers that repo's own per-project entry.
- **Test** — CAP-1 stdio-close spawn test made load-robust.

## v0.42.7 — 2026-07-05

Verifier-hardening-followups — the 7 OPEN defects the v0.42.3–v0.42.6 drain run left standing. Churn canary PASSED (2/2 promoted to `trusted` under one-shot peer churn, 0 leaked containers, `/data/.verifier-loop.state` survived throughout); it caught a severe CAP-2 stdin regression before any fleet drive.

- **Fix (blocker, CAP-2)** — MCP-only verifier peers now re-probe the `/data/.verifier.lock` flock (~60 s) and self-promote when the owner container dies — starting the verifier loop **and** its stall watchdog at runtime — so `verified → trusted` promotion resumes automatically instead of stopping forever. A promoting peer re-checks its own stdio is still alive first, so a dying peer never deletes the shared loop-state (the v0.42.0 deadlock class). `supervisor.sh`.
- **Fix (blocker, CAP-1)** — an MCP-only `eque2-state` container now exits when its parent session's stdio closes (a stdin-EOF handler in the state- and tests-server entrypoints), instead of idling forever (~40 leaked per day). Distinct exit log line.
- **Fix (CAP-5)** — `state_health` now exercises the two defect classes that hid inside an all-green health during the v0.42.5/v0.42.6 deadlocks: an `evidence-path round-trip` sub-check (through the same resolver `state_verify` uses) and a `scenario-filename routing` sub-check (through `SCENARIO_FILE_PATTERN`). Either goes RED when its defect is present; both report NA on a fresh store.
- **Fix (CAP-6)** — `SCENARIO_FILE_PATTERN` no longer mis-captures the scenario id under an uppercase-segment feature slug (`verify-CLOUD-DEPLOY-S1.spec.ts` → `S1`, not `DEPLOY-S1`) — silent evidence misrouting, the same class as the v0.42.6 dotted-slug miss. Greedy prefix + explicit id vocabulary; compound ids (`C4-RESET.1`) still route.
- **Fix (CAP-7)** — four test suites under `scripts/test/` never ran (outside the vitest include globs); salvaged/migrated/removed them, and added a guard test that fails if any `*.test.ts` sits outside the running globs.
- **Docs (CAP-4)** — the headless `[DS]` contract now specifies a poll-to-completion loop (hold the session to a terminal verdict / honest failure, never a false `ok` while the trust backlog is non-empty). The harness-turn-ending remainder is a logged followup.
- **Fix** — two pre-existing gate blockers: a `tsc` error at `state.ts` (the v0.42.5 re-verify branch) and stale `skipped`-is-terminal test assertions (`skipped` is not a reachable machine state).

## v0.42.6 — 2026-07-04

- **Fix (blocker)** — the scenario-state-reporter's filename router rejected DOTTED feature slugs: `SCENARIO_FILE_PATTERN`'s prefix class omitted `.`, but `create-spec` derives slugs from folder names that legally contain dots (`cfte-3-pages-1.1-1.5`) and registers them verbatim in every scenario `testFile`. The reporter silently skipped every such file — no evidence written, no verdict minted, scenario stuck `untrusted`, `[DS]` ungated at verify. Prefix class widened to admit `.` (id capture stays anchored on an uppercase lead; slugs are lowercase — no ambiguity). Regression tests added under the RUNNING suite (`src/eque2-code/test/`); note the legacy `scripts/test/scenario-state-reporter.test.ts` sits outside the vitest include globs and never executed.

## v0.42.5 — 2026-07-04

- **Fix (blocker)** — `state_verify`/reconcile resolved scenario evidence at the wrong base: `loadAllActors` returns `file` as a synthetic `kind:id` key (not a path) since the plaintext-storage migration, so the re-check stat'd `'../../evidence/<id>.json'` against the process CWD, failed all four structural sub-checks on healthy signed evidence, and demoted `verified` scenarios on every re-verify — the in-container verifier correctly refused to promote and `[DS]` deadlocked at the trust backlog (`stalled: verifier backlog not drained`). Evidence now resolves from the spec folder, the same base the completion-time check uses.
- **Fix** — a re-verify of an already-done scenario is now a no-op evidence refresh (parity with the task path's `verified→verified` refresh) instead of firing an invalid `complete` transition from `completed` — that branch was unreachable while the path defect made every re-verify fail structurally first.

## v0.42.4 — 2026-07-04

- **Fix (blocker)** — `[CS]` `cs-generate-definitions.py` task-field extraction: the optional colon in the field patterns let a hard-wrapped prose line beginning with a keyword (e.g. a Goal paragraph continuing "tests and extends it ONLY if…") match as the `Tests` field — first-match-wins meant the prose beat the real `**Tests:**` line, emitting `tests[].file = "and"`. The colon is now mandatory in every field pattern (`Tests`, `File`, `Goal`, `Supports`, `Depends On`, `Phase`, `Working Directory`, `Action`); both `**Field:** value` and `**Field**: value` placements are accepted. Three regression tests cover wrapped-prose non-capture and colon-placement variants. Same defect class as v0.42.3's `extract_test_dir` heading capture.

## v0.42.3 — 2026-07-04

- **Fix (blocker)** — `extract_test_dir` regex in `[CS]`'s `cs-generate-definitions.py` matched the `## Test patterns / TEST_DIR` *heading* line and captured `"TEST_DIR: scripts"` as the test directory, poisoning every regenerated `definitions.json` with invalid `testFile` paths that pass the `{PLACEHOLDER}` guard (they contain no braces) but resolve to nonexistent files. The extraction is now anchored to the value line, with regression tests covering the heading-capture case.
- **Fix** — `state_init` placeholder guard hardened: path fields (task `tests[].file`, scenario `testFile`, `workingDirectory`) now also reject a label-bleed signature (`": "` — a colon+space never appears in a real path), so a recurrence of this class of generator defect fails loudly at init instead of seeding unverifiable state. Commands are exempt (colons are legitimate there).

## v0.42.2 — 2026-07-03

- **Fix (blocker)** — `{TEST_DIR}` placeholder made every scenario unverifiable: `[CS]`'s `cs-generate-definitions.py` emitted scenario `testFile` paths containing the literal `{TEST_DIR}` whenever it could not extract a test directory from `context.md`, and the engine performed no substitution — the path was stat'd literally at verify time, so no scenario could ever reach `verified` and `state_done` was unreachable (field report 2026-07-03, all 13 cfte-* epics). Three-layer fix:
  - **Generator:** never emits the placeholder — when context extraction fails it resolves the test directory via the four-strategy `cs-resolve-test-dir.py` (which always yields a value).
  - **Engine guard:** `state_init` now hard-fails with a field-by-field error when a `definitions.json` path/command field carries an unresolved `{PLACEHOLDER}` token (descriptions/gherkin may still use braces), instead of silently storing unverifiable state.
  - **Rescue path for already-seeded specs:** `state_metadata --set test_dir=<abs path>` now persists (the schema previously stripped the key silently — why the field report found no `test_dir`), and scenario verification substitutes `{TEST_DIR}` from it at verify time — no destructive re-init needed on specs with completed work.
- **Fix** — Scenario `testFile` paths are now resolved against the project root (parity with task `tests[].file`); previously a relative scenario path was stat'd against the server's cwd (`/app` in-container) and always missed. Fail reasons print the resolved absolute path alongside the stored one.

## v0.42.1 — 2026-07-03

- **Fix (critical)** — Verifier survival on shared volumes: `supervisor.sh`'s exit trap deleted `/data/.verifier-loop.state` on EVERY container exit — including MCP-only peers and one-shot containers — which the Stop hook and restart loop misread as a deliberate shutdown, permanently killing a WORKING verifier mid-drain while its dead container kept the per-volume flock. This is the true cause of the v0.35.0/v0.40.1/v0.42.0 `verified → trusted` promotion deadlocks (the verifier itself promotes fine). Now: only the verifier-owning container may remove the shared loop-state file; the restart loop stops ONLY on an explicit `/data/.verifier-shutdown` marker written by the Stop hook on `<promise>shutdown</promise>`; an externally deleted state file triggers a visible respawn + self-heal instead of silent death; a stale shutdown marker is cleared at owner start.
- **Fix** — Watchdog no longer burns its stall-kill budget on a dead restart loop ("corpse-flogging"): it exits when the loop is gone.
- **Fix** — `launch-tests.sh` now rewrites the loop-state file on every spawn (parity with `launch.sh`), so the tests verifier also self-heals and never pins a stale prompt across image upgrades.
- **Tests** — New 9-case `verifier-loop-survival` suite drives the real supervisor/stop-hook functions through the ownership, marker, and corpse-exit branches; committed churn drain canary harness at `src/eque2-code/test/canary/` (binding proof: authed in-container verifier drained a real backlog to `trusted` verdicts + `state_done done:true` while 45 one-shot containers exited against the shared volume).
- **Note** — Rebuild the state image (`/eque2-code-setup` builds `eque2-state:v0.42.1`) and retire ALL v0.42.0 containers on a volume before draining it: an old-image peer exiting mid-drain still deletes the shared state file.

## v0.42.0 — 2026-07-02

**Breaking: SQLite is gone. State is now human-readable, HMAC-signed plaintext.** The encrypted SQLite state DB (and the `better-sqlite3-multiple-ciphers` page cipher, and the Ed25519 verdict split) are removed. All state now lives in git-committed, signed-plaintext `state/events.jsonl` that the container verifies at read. Everything integrity-related collapses into **one symmetric key** — the `integrityKey` (HMAC-SHA256, `keyId`-versioned).

- ⚠️ **A re-onboard is required, and a NEW age key is needed.** Because the state is shared across the team, every developer's container must hold the **same** `integrityKey`. It is distributed as a **SOPS + age encrypted-in-repo** blob (`state/.integrity-key.sops.json`): each dev decrypts it at setup with their personal **age private key** and the plaintext lands in the OS keychain (the same channel `EQUE2_STATE_KEY` used). **If you have never used `age`/`sops`, you now need an age keypair** — `/eque2-code-setup` step 4b generates one and walks you through sending your PUBLIC key to a maintainer. Do not be surprised by a suddenly-required age key: this is expected.
- 📖 **Read `references/key-onboarding.md` before upgrading.** It is a verbose, hand-holding onboarding guide (mental model, maintainer's side — adding/removing recipients + rotation, dev's side — first run/returning/after-rotation, and a symptom→cause→fix troubleshooting table). Setup step 4b is the guided version of it.
- feat: **verbose, self-narrating key onboarding** in `/eque2-code-setup` (step 4b). It detects your onboarding stage by name — first-time / returning / post-rotation re-key / not-yet-a-recipient — checks every prerequisite (`age`, `sops`, your age key, the encrypted blob) with the exact fix command on any miss, narrates each step with ✅/❌, walks a new dev through the recipient dance (generate keypair, send PUBLIC key, private key never leaves the machine), enumerates ≥6 named failure modes with recovery (no bare stack traces), and ends with an explicit write-then-verify proof that the key actually works.
- feat: **key rotation designed in from day one** via a `keyId` on every record; both keys are held during the overlap so history stays valid. A record signed under a `keyId` this machine lacks reports `state signed under keyId=N which you don't have — re-run setup`, not a generic verify failure.
- feat: **headless / CI path** — inject the key non-interactively via `INTEGRITY_KEY` (64 hex chars) from a CI secret instead of interactive age decryption; setup detects headless vs interactive and takes the right path.
- ⚠️ **Migration — finish or abandon in-flight `[DS]` work before upgrading.** This is a hard, forward-only storage-format break. A consumer repo with a live SQLite volume mid-`[DS]` must not be half-migrated: complete or abandon the in-flight build first, then upgrade. The setup migration runs once on a clean volume; setup detects a legacy volume and refuses to half-migrate with a loud message rather than stranding your work. **Re-run `/eque2-code-setup` after updating** — the storage/HMAC changes live in the `eque2-state:v0.42.0` image and the launch wrapper, and the integrity-key onboarding above must run.

## v0.41.0 — 2026-07-02

Fixes the `[DS]` verifier trust-promotion deadlock (field report 2026-07-02): builds whose tasks were all green could still never reach `done` because the in-container semantic verifier never promoted `verified → trusted`. **Re-run `/eque2-code-setup` after updating — the fixes live in the `eque2-state:v0.41.0` image and the launch wrapper.**

- fix: the in-container verifier actually runs now (B2). The loop prompt gets `EQUE2_FEATURES_PATH` substituted at launch (it previously shipped a literal `{EQUE2_FEATURES_PATH}` placeholder), the launch wrapper exports `EQUE2_FEATURES_PATH` into the container alongside the rw mount, and the supervisor watchdog watches the SAME heartbeat path the loop writes (they diverged before, making a hung verifier invisible).
- fix: the verifier session is allowed to call `state_verify` (the reconcile re-check was permission-blocked in the headless session) and can load its MCP tools via ToolSearch/Glob.
- fix: the watchdog treats a never-written heartbeat past a bounded boot grace (`EQUE2_VERIFIER_BOOT_GRACE_SECONDS`, default 900s) as a stall and kills/respawns — a verifier that wedges before its first heartbeat is no longer immortal.
- fix: the verifier loop state file is rewritten at every launch, so a stale prompt from a previous image cannot survive an upgrade.
- fix: tasks completed via `verb: complete` are reconcile-eligible once their code is committed (B1) — `state_verify` re-resolves the commit from current HEAD when no `commitSha` is stored, and persists it. Demote-safety is unchanged: a genuinely-red actor under `--reconcile` is still skipped.
- feat: `state_init` migrates interrupted-session parent snapshots (A) — stale `_machineVersion` parents are restamped at the current version with `subtaskActors` rebuilt from their children, and the response's `migrated` count is real (was hardcoded 0).
- feat: a stalled `state_next`/`state_done` now returns an actionable cause + recovery (diagnosing the verifier backlog and pointing at the new "Verifier-Backlog Recovery (verifyingSubtasks)" procedure in `autonomous-rules.md`/`setup.md`) instead of a silent empty (A).
- feat: the launch wrapper reaps stale same-volume `eque2-state` containers (older-version or exited) before `docker run`, so a leftover container can no longer hold the per-volume verifier flock and silently force MCP-only mode (C). A running current-version peer is never touched (multishell-safe).
- fix: `state_update` accepts `task/` / `scenario/` / `buildCheck/` prefixed ids, matching `state_query`'s surface (D).
- Validated by an authed live in-container drain canary: a seeded deadlock (3 `verified` leaves, parents stuck in `verifyingSubtasks`, `state_next` stalled) drained to `backlog=0` with real `state_verdict trusted` promotions, parents auto-advanced, and `state_done → {done:true}`. The verifier's adversarial gate was also exercised: trivial placeholder tests were rejected, not promoted.

## v0.40.1 — 2026-07-01

- fix: `/eque2-code-setup` now installs `.signer-key` deny-rules into the target repo's `.claude/settings.json` (mirroring `.evidence-key`). The forge-proof signer private key lives on the host, where `0600` alone does not stop a coding agent running as the same user from reading it — the deny-rules are the actual barrier that stops an agent forging a verdict, so they must ship with the install, not just live in the dev repo.

## v0.40.0 — 2026-07-01

- feat: forge-proof **shared** test state. Test verdicts now live in git-committed, mergeable files so a teammate sees a minted verdict on `git pull` — and a coding agent cannot forge a pass.
  - `state/events.jsonl` — append-only signed-verdict log with `.gitattributes merge=union`, so two devs minting different tests on branches merge with zero conflicts; regenerable per-test snapshots in `state/snapshots/` (never hand-merged).
  - Per-dev **Ed25519** verdicts binding `testId + hash(test_file) + commit_sha + result + ts + nonce`. Private key held in `.signer-key` (gitignored, mode 0600, deny-ruled — hidden from the agent, like `.evidence-key`); public keys committed one-file-per-key in `state/signers/`. Verify-at-read rejects hand-edited, replayed, and agent-forged verdicts; the test-file-hash binding lets a genuine verdict survive later commits while the test is unchanged.
  - Minting is **local** (the vitest reporter mints a signed verdict into the committed log on every test run) — no CI, no push, no merge gate required.
  - `verdict-status` reader + `post-merge` banner hook: a loud, team-visible pass/fail summary on every pull that flags any verdict failing signature/binding verification.
  - `state_init` now provisions the signer keypair, the `merge=union` attribute, and the `.signer-key` gitignore entry.

## v0.39.1 — 2026-07-01

- fix: `/eque2-code-prepare-goal` charters now carry a mandatory anti-bypass block. When eque2-code is the resolved mechanism, the stamped directive includes an explicit "⛔ BYPASSING THIS PIPELINE IS ABSOLUTELY FORBIDDEN" prohibition and a "⚠️ ENFORCEMENT" switch-off clause, forbidding hand-writing implementation/tests, skipping or faking `state_init`/`state_update`/`state_verify`/`state_done` or the eque2-tests gating, self-certifying `/goal` checkboxes over unverified work, or substituting weaker tests. Countermeasure to the #1 downstream failure — agents silently routing around the state machine and self-certifying a green checklist over broken software.

## v0.39.0 — 2026-06-26

- feat: `/eque2-code-prepare-goal` now runs a closing **Phase D — Documentation refresh** after the Phase R adversarial contract review. Phase D invokes the BMAD `bmad-document-project` workflow so the project's AI-context docs reflect the new SPEC + planning artefacts before hand-off, refreshes docs in-place (not green-field), verifies they landed on disk, and links the refreshed doc paths from the charter's frontmatter. Skipped only when nothing landed in `_bmad-output/` this run; the skip is journalled with reason. Anti-pattern guard added — calling the run done after Phase R without Phase D leaves the docs pointing at the previous project state.
- fix: `/bmad-help` discovery and recommendation of eque2-code capabilities tightened further (rolled in from the inter-version fix-up commit).

## v0.38.0 — 2026-06-25

- feat: eque2-code now ships two workflow skills that install alongside the module — **`/eque2-code-prepare-goal`** (turn a prompt/spike into a spec-driven GOAL-READY charter with a `/goal`-driveable Done-when checklist) and **`/eque2-code-journal`** (per-workstream run journal: capture what was tried/worked/failed so later runs can be briefed). Both are registered in `/bmad-help` (`[PG]`, `[JN]`) so they surface in the catalog after setup.

## v0.37.0 — 2026-06-25

- fix: `/bmad-help` can now discover and recommend eque2-code capabilities ([CS], [DS], [PR], [BK], Linus, Grace, …). Setup no longer wipes `_bmad/_config/` during legacy cleanup — that directory holds `_bmad/_config/bmad-help.csv`, the catalog `bmad-help` reads for **every** module, so wiping it broke `/bmad-help` globally (base modules included). Re-run `/eque2-code-setup` to repair an already-broken repo.
- feat: setup now registers eque2-code's capability rows into `_bmad/_config/bmad-help.csv` (the file `bmad-help` actually reads), in addition to `module-help.csv`. Anti-zombie keyed on `eque2-code`, so a pre-existing catalog's base-module rows are preserved; the file is created with the canonical header if absent. **Re-run `/eque2-code-setup` after any base BMad reinstall** — a base reassembly drops eque2-code's rows until setup re-merges them (the re-merge is idempotent).
- fix: eque2-code's help rows now use the canonical `preceded-by`/`followed-by` column header (reverting a self-inflicted `after`/`before` divergence), so `bmad-help`'s column-name parse reads the sequencing hints correctly.
- fix: `merge-help-csv.py` gains two safety guards — a source-purity guard (aborts if the source carries any non-eque2-code rows, which would otherwise wipe another module's base rows) and a header-compatibility guard (forward-repairs a legacy `after`/`before` target to canonical; fails loud on an unknown column order rather than silently misaligning data). The catalog is now written with LF line endings.

## v0.36.0 — 2026-06-25

- feat: the in-container semantic verifier now **reconciles the cold backlog** instead of only reacting to live transitions. On every pass it scans all `completed` actors at `verified`/`pending_review` (via the new server-side `state_query --trust-level=` filter), re-checks each with a non-demoting reconcile path, and promotes the green ones to `trusted`. A verifier outage mid-build (restart, host sleep, stall-kill) no longer strands the spec in a permanent deadlock — the stranded actors are found and drained on the next pass, parent tasks leave `verifyingSubtasks`, and build-checks/scenarios un-gate so the spec reaches `done`.
- feat: `state_query` gains `--trust-level=<level[,level…]>` — filter actors by `evidence.trustLevel` server-side (an unknown level errors cleanly). `state_query "task/*"` now also matches the type-qualified glob form.
- fix: re-verifying an actor whose evidence is now green but stale (a no-op `verified→verified`) refreshes the stored structural evidence instead of dropping it. A new `state_verify … --reconcile` mode is upgrade-only — a transient red re-check leaves a good actor (and its parent) untouched (`skipped`), never demoting it.
- fix: reconciliation is observable — the verifier records `reconcile scanned/backlog/promoted` per pass and advances its heartbeat on reconcile passes, so a "recovered but doing no work" verifier is no longer invisible.
- fix: `[CS]` create-spec now emits valid spec definitions — task `Tests:` patterns are sanitised (markdown artifacts like `(full suite)**Test Cases:**` are stripped/rejected; `(full suite)` is honoured as a contract sentinel), and a mandatory `Depends On:` field per task produces a real `dependsOn` dependency graph in `definitions.json` so `state_next` can sequence the work.

## v0.35.0 — 2026-06-25

- fix: multiple Claude Code shells in the same repo no longer break the state MCP server. Opening a second (or Nth) shell previously killed the first shell's container — its live MCP connection dropped. The launchers no longer reap peer containers; concurrent access to the shared encrypted SQLite volume is made safe with WAL + `PRAGMA busy_timeout` (writers wait for the lock instead of erroring), verified empirically (concurrent cross-container writers, zero lost writes, `integrity_check=ok`).
- fix: the in-container verifier is deduped to one loop per volume via an `flock`, so extra concurrent shells add no extra verifier loops (no redundant token burn or writers).
- fix: stop the in-container verifier from corrupting the MCP JSON-RPC channel. Its stdout (and the watchdog's) is now routed to stderr, eliminating the `Ignoring non-JSON line on stdout` errors that garbled/dropped the connection.

## v0.34.0 — 2026-06-24

- feat: stall supervisor for the in-container test verifier — `[BK]`/Linus/Grace test builds no longer hang invisibly. The verifier now journals a per-stage heartbeat + `progress.jsonl` under `.eque2-tests/runs/{testId}/{runId}/` (via a baked `hb.sh` that survives the agent's separate shells), so progress is observable from disk.
- feat: container stall watchdog in `supervisor.sh` — detects a wedged-but-alive verifier from heartbeat staleness (default 20 min, `EQUE2_VERIFIER_STALL_SECONDS`), kills it so the restart loop respawns, bounds restarts to 3 (resets on recovery), and drops a host-visible `.verifier-stalled` sentinel when it gives up.
- feat: timer-driven lease sweep in the `eque2-tests` server — expired verification leases are reclaimed on a schedule, decoupled from `test_verdict('lease')`, closing the deadlock where a hung verifier could never release its own lease.
- feat: `test_run_log` locates an in-flight run (leased, pre-verdict) so a stall is diagnosable before any verdict is recorded.
- feat: `[BK]` relays verifier health — surfaces stalls and the give-up sentinel during its poll loop, records them in the run report (with log locations), reads the prior report on startup, and Linus/Grace point new agents at the artifacts. New dial `verifier_stall_threshold_minutes`.
- fix: Playwright run hardened with `timeout -k 30 600` (force-kill a SIGTERM-ignoring child) and real exit via `PIPESTATUS` (no longer masked by `tee`).

## v0.33.1 — 2026-06-23

- fix: in-container verifier auth/origin parity — the `eque2-tests` launcher now emits an actionable NOTE when it rewrites a `localhost` `BASE_URL` to `host.docker.internal` (the origin change silently broke cookie-credentialed auth in-container, e.g. `restore_token` 401s); it stays silent when `BASE_URL` is already the canonical host.
- feat: setup now configures host↔container origin parity — checks `/etc/hosts` for `host.docker.internal` and hands the user the `sudo` one-liner, recommends a canonical `BASE_URL`, and names the dev-server host-check requirement.
- docs: add `references/in-container-verification-auth.md` — the general "capture on host, inject via the read-only mount" contract, including the target-repo requirement that `global-setup` capture full `storageState` (cookies + localStorage, not a bare token).

## v0.33.0 — 2026-06-22

- **Feature** — **Jira is now optional.** Setup checks for Jira credentials and continues either way instead of hard-failing. They unlock the Jira-sourced workflows ([JF] Jira Fetch, [ET]/Xray E2E generation); without them you can still install, launch Linus, and spec from a plain prose brief — `CS @brief.md` runs end-to-end with no Jira at all. Add the credentials to `.env` and re-run `/eque2-code-setup` whenever you want the Jira paths. Updated across the module description, greeting, post-install notes, and Linus's persona seeds.
- **Feature** — **Deferred birth for first-timers (Linus).** A first message that fast-invokes a real workflow (e.g. `CS PROJ-123`, `CS @brief.md`) no longer traps you in the 15–20 minute First Breath interview — Linus offers to run now on sensible defaults and learn how you work as it goes, then prompts for a proper First Breath on a later session. An accidental landing on Linus now aborts cleanly instead of leaving a half-built sanctum, and menu codes are surfaced as optional shortcuts to newcomers.
- **Feature** — **Post-PR lifecycle (Linus).** Linus no longer goes silent at an open PR: it surfaces a closing beat (PR link, feature flips to *In review*, next move) and can re-enter via [PR] in *address-review* mode to take reviewer comments test-first and push to the same PR. The lifecycle now matches the "I carry it the whole way" identity.
- **Feature** — **`--headless:re-spec` and `ship --until:<stage>` (Linus).** Added the headless re-spec task (the correct unattended remedy for a `feature_exists` collision when requirements changed — the collision halt-message now points at it), and a stop-before-stage control for `--headless:ship`. A bootstrapped/deferred sanctum now offers a proper First Breath on the next interactive activation.
- **Feature** — **Non-Xray E2E path for prose-first specs (Linus).** [ET] no longer dead-ends prose-first owners at the Xray HARD STOP; it offers to generate the Playwright E2E directly from the spec's `scenarios.gherkin`. Jira-sourced specs keep the Xray-gated behaviour unchanged.
- **Improve** — **State-MCP graceful degradation (Linus).** Interactive [DS]/[ET] now probe `state_health` before the expensive dispatch and, if the `eque2-code-state` server is unreachable, degrade to an actionable message (likely cause + the one recovery command) instead of stalling deep in the build. The CREED Dominion guardrails are now a required compaction defence in long sessions, not a suggestion.
- **Improve** — **New `headless-envelope.py` stamper (Linus).** Headless tasks now stamp the mandatory `timestamp`/`agent_version`/`session_log` fields and select their exit code via a deterministic script, hardening the envelope contract and removing the largest recurring headless token tax.
- **Chore** — Removed the dead `test_file_prefix_hint` knob from Linus's agent block (it was a silent no-op; the live copy lives on the create-spec workflow) and documented that identity scalars are read-only at runtime and glob overrides don't propagate to a standalone [CS] invocation.

## v0.32.1 — 2026-06-19

- **Chore** — update setup module display name and greeting text.

## v0.32.0 — 2026-06-19

- **Fix** — **Xray now defaults to the EU Cloud endpoint.** `XRAY_BASE_URL` now defaults to `https://eu.xray.cloud.getxray.app` (was the global `https://xray.cloud.getxray.app`). Override `XRAY_BASE_URL` in `.env` to target a different region — e.g. the global host.
- **Fix** — **Setup now documents the real Xray env-var contract.** The eque2-xray section lists exactly the variables the server reads: required `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`, and `XRAY_PROJECT_ID` (the last was required by the code but previously undocumented), plus optional `XRAY_BASE_URL` and `XRAY_OUTPUT_DIR`.
- **Improve** — **Setup offers to discover `XRAY_PROJECT_ID` for you.** Since the numeric project id isn't shown in the Jira URL, setup takes your Jira project URL, extracts the project key from `/projects/<KEY>`, and resolves the numeric id via the Atlassian API (`GET /rest/api/3/project/<KEY>` → `id`). Notes that any `selectedFolder=…` in the URL is the Xray test-repository folder id, not a project id.

## v0.31.0 — 2026-06-19

- **Improve** — **Grace is now the Test Automation Orchestrator** (was "Test Backfill Orchestrator"). Her identity now reflects what she already does end to end — set up test topology & standards, fetch and gate Xray definitions, build single tests or bulk-backfill whole folders through the shared E2E pipeline, validate test quality against the anti-flakiness rubric, sync results to Xray, and report coverage. Bulk backfill is one capability among many, not her whole job. Updated across her description, mission, persona/creed seeds, the "About Grace" greeting, the module roster/greeting, and the help catalogue.
- **Improve** — **Both Linus and Grace now reliably surface their full command menu on invocation.** The capability menu (every visible item, not just the happy-path entry point) is presented on every activation — both the normal rebirth path and at the end of First Breath — so you always see the workflows each agent offers when you talk to them.
- **Fix** — Grace's First Breath capability pitch and the help catalogue now include the `[XC]` (Xray conformance gate) and `[TV]` (test-quality validation) capabilities, which were previously omitted from those summaries.

## v0.30.2 — 2026-06-19

- **Improve** — `test_run_log` is now self-diagnosing. A `runLogDir: null` previously left you guessing between two unrelated causes; the verb now returns `logDirConfigured` and a precise `note` distinguishing (a) the server has no `EQUE2_TESTS_LOG_DIR` — restart Claude Code after upgrading so the launch wrapper injects the artifacts mount — from (b) `lastRunId` is null — the test has not been verified since artifact logging landed, so there is no run to locate yet (re-drive it, then re-query). Note: a run log only exists *after* a verification actually executes under v0.30.x; an existing/queued test queried right after upgrade has no artifacts until it next runs.

## v0.30.1 — 2026-06-19

- **Fix** — the `eque2-tests` MCP server failed to connect after a v0.30.0 install. The launch wrapper reads optional keys from the project `.env` with a `grep | …` pipeline under `set -euo pipefail`; when `.env` exists but a key is absent, the `grep` miss failed the pipeline and aborted the whole script at the `VAR="$(read_env KEY)"` assignment — before `docker run` — so Claude Code reported "Failed to connect". The new `EQUE2_TESTS_LOG_DIR` read (a key almost never present in a project `.env`) made this fire on every install. `read_env` now tolerates a missing key (returns empty) instead of killing the launcher. A new wrapper integration test drives the real script to the `docker run` boundary across `.env` permutations so this regression cannot recur.

## v0.30.0 — 2026-06-18

- **Feat** — `test_force_reset` (new MCP verb): a confirm-gated escape hatch that returns a budget-exhausted / stranded test (`blocked` / `needs_compliance_fix` / `needs_run_fix` / `failed`) to `pending`, clearing both the reset and fix budgets. Recovers tests that hit the 5/5 reset ceiling — for *any* reason, including upstream bugs that consumed the budget — without admin rights or direct DB surgery. Logged as a `FORCE_RESET` transition.
- **Fix** — `RESET` no longer reports a false "reset budget exhausted (5/5)". The cmd layer conflated two distinct non-moves: a genuinely budget-blocked reset vs. `RESET` sent from a state that has no reset arc (e.g. `awaiting_verification`). The former now reports the *actual* count `(n/5)`; the latter says "RESET is not valid from state '<x>' — the reset budget is not the cause." A freshly-seeded test leased into verification is no longer mislabelled as budget-spent.
- **Fix** — boolean/numeric `Schema.Literal` tool inputs now validate over the wire. The Effect-Schema→Zod converter forced every enum through a string-only `z.enum`, so a `confirm: true` argument was silently rejected by MCP input validation — which also affected the existing `test_verification_reset` admin verb. Now mapped to `z.literal` / a union of literals.
- **Fix** — server-side verification runs the spec through the **target repo's own `playwright.config.ts`** (repo-agnostic) instead of a generated minimal config that bypassed it. Bypassing the repo config skipped its `dotenv`/`baseURL`/`projects` wiring, so specs reading `process.env.*` for their URL/credentials navigated to `undefined` and "failed to log in" even when correct. The verifier now wraps the repo config (overriding only the container's chromium path, headless, and artifact capture), falling back to a minimal config only when the repo has none.
- **Feat** — verifier observability. Per-run Playwright artifacts (`trace.zip`, screenshots, video, stdout/stderr) are now persisted to a host-reachable directory (`EQUE2_TESTS_LOG_DIR`, default `<project>/.eque2-tests/runs/<testId>/<runId>`, bind-mounted read-write). `lastRunId` is populated on failure verdicts (was always null), and a new always-on `test_run_log { testId }` verb returns `lastRunId` / `failureReason` / `failureCategory` / the host `runLogDir`, so a `needs_run_fix` is diagnosable from a session without `docker exec`. New `bin/eque2-tests-tail.sh` streams a verification run live.
- **Feat** — setup-time canary smoke check (`bin/eque2-tests-smoke.sh`): drives a `SEED → blocked → RESET → force_reset` round-trip against the freshly-built image over an ephemeral DB (no real state touched), asserting the reset path works and the reset budget initialises at 0/5 and accounts correctly — on macOS, Windows, and WSL. Warn-level; never blocks install.

## v0.29.3 — 2026-06-18

- **Fix** — server-side verification no longer silently orphans tests that lack a spec path. Root cause: `SEED` accepted a `testFilePath` but discarded it (only `BUILD_COMPLETE`/`FIX_SUBMITTED` persisted it), so a build completed with no path left `testFilePath: null`; the in-container verifier then had nothing to run, errored three times, and the test landed in `failed`/`orphaned` (with `runAttempts: 0`) minutes after queuing. Three-part fix: (1) `SEED` now persists `testFilePath` (and a re-SEED patches it onto an existing record); (2) any transition into `awaiting_verification` with an empty `testFilePath` is **refused at write time** with an actionable error — the test stays `building` instead of orphaning later; (3) the verifier resolves a repo-relative `testFilePath` against the project mount (new `EQUE2_TESTS_PROJECT_DIR`, set by the tests launcher) rather than its `/app` working directory. Repo-relative paths are now the recommended form — portable across Windows and WSL, since only the per-host mount base differs.

## v0.29.2 — 2026-06-18

- **Fix** — the eque2-tests defense-in-depth deny rules (setup step 6.7) used an invalid Claude Code permission pattern (`Bash(docker run:*eque2-tests*)`) — a `:*` token is only legal at the end of a rule, so Claude Code skipped both rules with a validation warning on install. Corrected to the space-before-wildcard substring form (`Bash(docker run *eque2-tests*)`, `Bash(docker exec *eque2-tests*)`); the merge snippet now also strips any malformed variants a prior install wrote. To clean an already-installed repo, re-run `/eque2-code-setup` (it removes the bad rules and adds the valid ones) or delete the two `…:*eque2-tests*` lines from the project's `.claude/settings.json`.

## v0.29.1 — 2026-06-18

- **Fix** — robust `module_version` parsing in the setup skill. The previous `grep | awk '{print $2}'` assumed a space after the colon and silently produced an **empty** version (→ a malformed `eque2-state:v` image tag) on `module_version:0.29.0`, an inline comment, or a quoted value. Replaced across all five sites (SKILL.md ×2, `bin/eque2-state-launch.sh`, `bin/eque2-tests-launch.sh`, `bin/eque2-tests-admin.sh`) with awk-free bash (`cut` on the colon + parameter-expansion stripping of comment/quotes/whitespace), matching the skill's own PyYAML-over-awk guidance.

## v0.29.0 — 2026-06-18

- **Feature** — the **`eque2-tests` test-lifecycle MCP server** now ships and serves test states. Grace's `[AT]`/`[BK]`/`[US]`/`[RP]` capabilities read from and report to it (`mcp__eque2-tests__test_*`) — previously they degraded gracefully because the server did not exist. It runs as a sibling server inside the same `eque2-state` Docker image (`EQUE2_SERVER=tests`), with its own Docker volume (`eque2-tests-<hash>`) and encrypted SQLite DB (`/data/tests.db`), so backfill lifecycle state never touches feature-development actor state. Registered at `/eque2-code-setup` (new step 6.7); a Linus-only install never needs it.
- **Feature** — a rationalised **8-state test lifecycle** (`pending`, `blocked`, `building`, `awaiting_verification`, `needs_compliance_fix`, `needs_run_fix`, `verified_passing`, `failed`) as a pure XState FSM validated against a `defineSpec` contract. Nine always-on agent tools (`test_update`, `test_reset`, `test_summary`, `test_next`, `test_query`, `test_report`, `test_analytics`, `test_transitions_since`, `test_verification_reset`) plus a verifier-gated `test_verdict`. Server-side events (`VERIFIED_PASSING`, …) are structurally unreachable from the agent surface — an agent cannot self-certify a pass.
- **Feature** — server-side verification worker: a container verifier loop leases an `awaiting_verification` test, applies the compliance rubric (the `[ET]` Stage 6 fidelity gates, shipped immutably inside the image), runs the spec live with Playwright (pinned chromium), and mints HMAC evidence on pass. The evidence key never leaves the container and is exposed by no verb. Bounded leases auto-recover orphaned verifications.
- **Internal** — new v3 test-lifecycle schemas (`test-lifecycle-context@3`, `test-lifecycle-state@3`, `test-lifecycle-snapshot@2`) registered and emitted; warn-level `tests_server` pre-flight check; deny-rules merged at setup so an outer agent cannot impersonate the in-container verifier.

## v0.28.0 — 2026-06-18

- **Feature** — new **`[TV]` Test Validation** skill (`eque2-code-test-validation`): scores a Playwright `*.spec.ts` (or a folder/glob) against a researched anti-flakiness rubric — hard waits, positional/CSS selectors, floating promises, captured `ElementHandle`s, `networkidle` waits, isolation debt — reports per-test findings with severity and line refs, then **offers to auto-fix** the mechanically-fixable ones under explicit confirmation (never silent; report-only when headless). Generates no test. Visible on Grace as `[TV]` (single test or whole folder/batch); available standalone as `/eque2-code-test-validation <spec|folder|glob>`. The canonical best-practice docs ship bundled in the skill's `references/` (build-time guidance + validation rubric + constrained-SPA playbook).
- **Feature** — Linus's `[ET]` E2E pipeline now **builds to the standard and validates against it**. Stages 3/5 and `engine.md` cite the bundled build-time guidance so generated tests start compliant; Stage 6 runs `[TV]` as an always-on internal gate after the fidelity gate, within the existing ≤3-iteration fix budget — a test that can't be made compliant is surfaced, not forced green. `[TV]` is hidden-internal on Linus (mirroring `[XC]`), visible on Grace.
- **Fix** — repaired a capability-registry parity drift: `[XC]` Xray Conformance was present on both agents' menus but missing from their `bmad-manifest.json` capability lists (both parity tests were failing). Added it to both manifests; registered `[TV]` in `module-help.csv`.

## v0.27.0 — 2026-06-18

- **Feature** — **Grace, the Test Backfill Orchestrator** (`/eque2-code-agent-grace`) joins the module as Linus's sibling. Grace works the Xray backlog at scale: pull written test definitions in bulk, turn each into a verified, evidence-backed Playwright test through the shared E2E pipeline, and sync results home to Xray. New capability skills: `[SU]` test-setup, `[FT]` fetch-tests, `[AT]` test-status, `[BK]` backfill, `[US]` update-status, `[RP]` test-report (plus `[BT]`, the shared E2E pipeline driven by an Xray test ID). The module greeting and roster now introduce Grace alongside Linus. **Note:** Grace's lifecycle-server-backed capabilities (`[AT]`/`[BK]`/`[US]`/`[RP]`) degrade gracefully until the `eque2-tests` lifecycle MCP server ships — they surface an honest "re-run `/eque2-code-setup` on an upgraded module" pointer rather than fabricating state.
- **Feature** — new **`[XC]` Xray Conformance** review (`eque2-code-xray-conformance`): the step-conformance gate — fetch the Xray definition fresh, read `stepCount`, report conformant (`≥1 step`) or non-conformant — extracted into a standalone, user-runnable skill. Runs against a single Xray test ID or a whole folder (per-test report), and **generates no test**. Visible on Grace as `[XC]`; available standalone as `/eque2-code-xray-conformance <id|folder>`.
- **Refactor** — the conformance gate now lives in **exactly one place**. Linus's `[ET]` (E2E test) keeps its feature-folder resolution and abort recording but **delegates the fetch-fresh → `stepCount` → re-fetch-prompt mechanics to `[XC]`** instead of inlining them. Grace's Hard Rule 2 and the `spec-playwright-e2e-test/xray-gate.md` spec now reference the skill rather than restating the algorithm.
- **Fix** — registered all Grace skills and the new conformance skill in the module capability registry (`module-help.csv`); they were previously absent.

## v0.26.0 — 2026-06-11

- **Feature** — **project documentation is now a pre-flight expectation** for the doc-dependent workflows (`[CS]`, `[DS]`, `[RS]`, `[BF]`, `[ET]`). Pre-flight gained a `project_docs` check that looks for the `bmad-document-project` index; when it's missing, those workflows **strongly recommend running `bmad-document-project` first** and offer to launch it, explaining the cost of skipping it (slower re-discovery every run, lower-quality specs that miss cross-cutting concerns, and reduced reliability on large/unconventional codebases). It's a loud recommendation, **never a blocker** — `[JF]` and `[PR]` note the gap quietly without nagging.
- **Feature** — `[IS]` (install-styleguide) now **confirms project documentation exists** as part of its verify stage, recommending `bmad-document-project` if it doesn't, and **ensures the docs are committable to Git** — if a `.gitignore` rule would exclude the docs path, it adds a negation so the documentation actually gets tracked (interactive confirms the edit; headless applies and logs it).
- **Feature** — new `project_docs_glob` configurable on Linus and each doc-dependent skill (defaults to `{project-root}/docs/index.md`; override to `{planning_artifacts}/index.md` where docs are written there), forwarded to pre-flight via the new `--project-docs-glob` flag. Added test coverage for the new check (present / missing / custom-glob).

## v0.25.0 — 2026-06-10

- **Feature** — every session now performs an **auto-update check**: it reads the latest published version from the repo's `eque2-code-v*` git tags and, if the installed copy is behind, surfaces a soft "newer version available" notice with the exact `npx bmad-method install … ?ref=eque2-code-v<new>` command. The check is non-blocking — it stays silent when offline, when `gh` is missing, or when the version marker isn't present yet.
- **Feature** — `/eque2-code-setup` now installs the session startup rule into `.claude/rules/`, writes a `.version` marker, and ships the module CHANGELOG alongside it, so the auto-update notice and the shipped-feedback greeting work in every target repo. On a **version upgrade** the setup now **outlines what changed** (the changelog delta from the previously-installed version), then syncs `.last-seen-version` so the session rule doesn't repeat it.
- **Fix** — replaced the dead remote-version source (the retired `installers/bmad/eque2-code/version.txt` path, now a 404) with a git-tag lookup, and updated the advertised update command to the marketplace `npx bmad-method install` form.
- **Change** — the **correctness code review moved from `[PR]` to `[BF]` stage 6**, where the root-cause context lives. `[BF]` now runs a full, context-rich `bmad-code-review` on the finished fix, passing stage 2's root-cause/sibling-site analysis as the review's acceptance spec so it hunts specifically for an *incomplete* fix; findings are auto-applied (with a test each) and re-gated by the full suite, falling back to `bmad-review-adversarial-general` when `bmad-code-review` isn't installed.
- **Change** — `[PR]` no longer performs a correctness review (renamed stage 2 `review` → `standards`). It now enforces only the repo's house **review-rules** on the diff — stripping out-of-scope changes, debug leftovers, and secrets — and stops at an open PR. A change that reaches `[PR]` without passing through `[BF]`/`[DS]` ships without a correctness review by design.
- **Chore** — removed the retired `installers.retired/` guidance from the framework instructions; distribution is marketplace-only.

## v0.24.0 — 2026-06-04

- **Feature** — Linus now presents and carries the **full ticket-to-PR lifecycle** on every activation: `[JF]` fetch, `[CS]` spec, `[RS]` re-spec, `[DS]` build, `[ET]` E2E test, `[BF]` bug fix, `[PR]` open PR. The menu, greeting anchor, mission, and First Breath introduction were migrated off the old "ticket → spec" framing — Linus no longer hands the spec to a downstream agent, he *is* the one who carries it to a PR. The capability menu now hard-renders **every** visible workflow so the full lifecycle is always on screen.
- **Feature** — the **whole lifecycle is now scriptable headlessly**, not just the spec half: `--headless:develop-spec`, `--headless:e2e-test`, `--headless:bug-fix`, and `--headless:create-pr`, plus a `--headless:ship` chain (`[DS]`→`[ET]`→`[PR]`) and `--headless:bootstrap` for CI cold-starts (scaffolds the sanctum non-interactively). `unknown_task` now exits `2` (precondition failure) so cron can tell it apart from a task that ran and failed, and a re-entrancy/idempotency contract documents safe retries.
- **Feature** — new `sanctum-status.py` helper does the sanctum bookkeeping deterministically (presence, the 7-file check, birth status, stale-birth and session-pruning date math, and an unresolved-placeholder sweep) instead of in-prompt. Wired into rebirth routing, the headless gate, `--headless:health`, First Breath resume/cleanup, and memory curation.
- **Fix** — `CAPABILITIES.md` is now refreshed from the manifest on **every rebirth**, so a long-lived sanctum no longer silently drifts from the current capability set. A build-time parity guard fails if the menu (`customize.toml`) and the manifest ever diverge; capability descriptions were re-synced, and a stale state-tool count and a retired-validator reference were corrected.
- **Feature** — a cheap **pre-`[CS]` input-viability check** flags thin tickets/briefs before the expensive pipeline spends tokens, and an existing-folder collision guard offers `[RS]`/overwrite/open instead of silently clobbering a prior spec.
- **Feature** — install now **manages the target repo's `.gitignore`**: it ignores personal/runtime files (`config.user.yaml`, `.state-events.jsonl`, `.evidence-key`) while keeping the shared sanctum and generated docs committed, and warns if existing ignore rules would hide a shared path.
- **Change** — the per-module config-consolidation notice was **reworded** so a routine re-install no longer reads as an alarming "legacy format" migration; the default Jira URL shown in setup and error guidance is now `https://eque2.atlassian.net`.

## v0.23.0 — 2026-06-03

- **Feature** — `[PR]` Create PR and `[BF]` Bug Fix now **enforce the project's coding standards locally, before the push**. `[PR]` Stage 2 and `[BF]` Stage 6 load the resolved review-rules glob (under Linus `{agent.review_rules_glob}`, else the configured `review_rules_glob`, else default `.github/review-rules/*.md` — the Rule-ID'd anti-pattern catalogues `[IS]` installs), review the diff against them, and **fix in-scope violations**. These are the same standards an automated PR-review bot applies *after* the push — applied here *before* it, so PRs stop opening pre-loaded with style comments.
- **Scope discipline** — the check is scoped to the diff's added/changed lines (plus the enclosing function/class for block-level rules), matching the lines a PR-review bot anchors comments to. Pre-existing violations on untouched lines are left for a separate cleanup PR, preserving `[BF]`'s minimal-fix discipline.
- **Graceful degradation** — when no review-rules are installed the pass skips cleanly and records "no review rules found" (no fabricated rules, no stalling on install). `--yolo` skips the pass; `--no-adversarial` does not. The glob is configurable, so a repo whose guides live elsewhere (e.g. `.ai/Code Reviews/styleguides/*.md`) points it there.

## v0.22.0 — 2026-06-03

- **Feature** — `[BF]` Bug Fix now **auto-runs adversarial review on the finished fix** before declaring done. Stage 6 invokes `bmad-review-adversarial-general` to hunt for an incomplete "half" fix — sibling sites that share the root cause, untested input classes, a symptom-only patch. Critical and enhancement findings are auto-applied (with a test added/widened for each) and re-gated by the full suite. Suppressed by `--no-adversarial`/`--yolo`; capped at 3 apply-and-recheck iterations.
- **Feature** — `[BF]` Stage 2 investigation goes **width-first**: trace to the true origin, find every site that shares the root cause, enumerate the full input class, and define what "complete" means before touching code — directly targeting the half-fix failure mode.
- **Feature** — `[BF]` and `[PR]` **optionally transition the Jira ticket status** when running in the Jira flow (ask-first, never silent). `[BF]` offers to move the ticket to your *In Progress* status at intake; `[PR]` offers *In Review* after the PR opens. Target status names live in Linus's BOND.md "Their Jira Workflow", with graceful fallback to the ticket's available transitions when unset or running standalone.
- **Fix** — `[BF]`/`[PR]` Jira transition handles closed/terminal tickets with no available transitions cleanly (a one-line note and skip) instead of rendering an empty "Available moves" prompt.

## v0.21.0 — 2026-06-01

- **Feature** — `[ET]` E2E Test now **gates generated tests on specification fidelity, not just a green run**. Before any pass is recorded, an always-on gate checks that every Xray step is implemented as a `test.step()` with a real `expect()`, that no "verification theatre" slipped in (a `console.log`-only step, a `try/catch` around an assertion, `.catch(() => false)`, an `if (isVisible)` guard standing in for `expect`), and that grid/field entries are read-back-asserted. A green-but-shallow test is rejected and re-enters the bounded fix loop instead of being recorded green.
- **Feature** — honest **INDETERMINATE** outcome: when a test genuinely cannot verify its spec (a required prerequisite record/state is absent, or the app goes unresponsive), `[ET]` reports it distinctly rather than forcing a green pass or substituting fallback data. Surfaced separately from PASS/FAILED/SKIPPED in the handoff.
- **Feature** — a cheap **static-analysis gate** (typecheck / lint / optional `knip`) runs before commit where the project exposes it; a new type error, unused symbol, or dead export fails verification.
- **Feature** — Stage 4 (Explore) now records live-UI **freeze hazards**, and Stage 6's resilience audit adds a **locator-uniqueness sweep** (`count() === 1` required; scope rather than blanket `.first()`) plus **ranked healer remedies** (dismiss-overlay-and-retry first, interaction bypass only as a justified last resort).
- **Change** — strengthened the default test-standards: locator uniqueness under strict mode, read-back assertions after data entry, identity-not-presence when selecting a "latest" record, filter post-condition assertions, and a **reconciled `waitForTimeout` rule** — bounded recovery escape-hatches are permitted (paired with a bounded-visibility race), but blind sleeps remain forbidden. Repo-agnostic; motivated by the AI-93 test-stability remediation.

## v0.20.0 — 2026-06-01

- **Feature** — `[ET]` E2E Test: generates one Playwright end-to-end test for a completed change, **gated on an existing Xray definition** (a HARD STOP if none exists, so unbacked tests never enter the suite). It explores the live UI through a Playwright MCP before writing any selector, maps each Xray step 1:1 to a `test.step()`, commits the test in layers (navigation → interactions → assertions), and verifies green with a bounded fix loop. Engine depth is configurable (**core** by default, or **full** which adds a resilience audit + parallel healer). Runs between `[DS]` and `[PR]`; only applies to Jira-sourced specs. Available on Linus's menu and standalone as `/eque2-code-e2e-test`.
- **Feature** — a **run-once First Breath** inside `[ET]` establishes test config the first time (tests-necessary? where tests live, engine depth, the project's Xray folder), verifies/installs the Playwright toolchain + MCP, and generates a `test-standards.md` guidance file (TEA knowledge if present, else baked-in defaults). Settings persist to `.env` + `_bmad/_memory`; reversible via `ET --reconfigure`.
- **Feature** — the **`eque2-xray` MCP server** (Xray fetch + step counts) now ships with eque2-code. Its source was brought into `src/eque2-code` (superseding the retired eque2-test copy — zero eque2-test dependency), built to `scripts/xray-server.mjs`, and registered by `/eque2-code-setup`. `[ET]` fetches definitions fresh through it before every gate, so it never trusts a stale local copy.
- **Change** — Linus's menu now lists `[ET]` between `[DS]` and `[PR]`, and `[DS]`'s completion guidance points to `[ET]` then `[PR]`.

## v0.19.0 — 2026-06-01

- **Feature** — `[BF]` Bug Fix: a test-first bug-fixing workflow. It reproduces the bug locally before touching code, interrogates why existing tests missed it, writes a test that fails *for the right reason*, makes the minimal fix, and gates on the **full** suite — not just the new test — before declaring done. Chains `[JF]` when given a ticket key. It deliberately stops short of commit/push, writing a `bug-fix.md` handoff (reproduction, root cause, why-tests-missed, verification) for the ship step. Available on Linus's menu and standalone as `/eque2-code-bug-fix`.
- **Feature** — `[PR]` Create PR: the review-and-ship companion to `[BF]`. It reviews the diff (delegating to `bmad-code-review`), gates on a green suite, syncs the feature branch with the base (rebase or merge, inferred from the repo), commits with a ticket-linked message, pushes, and opens a pull request with a full description. It **stops at an open PR** — never merging — so human/CI review is never bypassed. Consumes `[BF]`'s `bug-fix.md` handoff. Available on Linus's menu and standalone as `/eque2-code-create-pr`.
- **Feature** — both new workflows are sanctum-aware on every dispatch path (including when Linus dispatches them): they key on whether the *knowledge they need* is recorded (test infrastructure for `[BF]`; git/PR conventions for `[PR]`) rather than merely whether a sanctum exists, and offer to capture it (or run First Breath) instead of silently guessing.
- **Feature** — install now **hard-stops when Jira credentials are missing or malformed** in the project's `.env`. A deterministic, network-free gate (`verify-jira-credentials.py`) runs before any configuration, file writes, or Docker image build, and refuses to fall back to the Atlassian MCP as a substitute — credentials are a hard prerequisite of installation, like Docker.
- **Docs** — post-install-notes clarify that Jira credentials (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) are a hard prerequisite, and that every workflow authenticates to Jira directly.

## v0.18.0 — 2026-05-30

- **Feature** — Linus's capabilities are now **separately invokable skills**. `[JF]`, `[CS]`, `[RS]`, `[DS]`, and `[IS]` are promoted from nested workflows to top-level registered skills (`eque2-code-jira-fetch`, `eque2-code-create-spec`, `eque2-code-re-spec`, `eque2-code-develop-spec`, `eque2-code-install-styleguide`). After install they appear as their own `/` commands and can be triggered by natural language — you no longer have to go through Linus.
- **Feature** — Linus is now the idiomatic thin persona + menu: its `customize.toml` carries an `[[agent.menu]]` mapping each code to a sibling skill, and it dispatches by invoking that skill via the Skill tool (the persona carries through). Matches how BMAD core agents (e.g. the PM) dispatch.
- **Change** — each promoted skill is self-sufficient: it resolves its own `customize.toml` and runs a shared pre-flight, so it works standalone or when dispatched by Linus. The shared pre-flight (`preflight-check.py` + `pre-flight-checks.md`) now lives in the always-installed setup skill.
- **Internal** — cross-capability calls (e.g. [CS]→[IS], [RS]→[CS]) now invoke registered skills via the Skill tool rather than file-loading workflow paths; `module-help.csv` registers each capability under its own skill.

- **Fix** — install now normalizes the `bin/*.sh` wrapper scripts to LF line endings before registering the MCP server. On Windows, a target-repo checkout with `core.autocrlf=true` could rewrite the launcher to CRLF, after which `bash` failed with `$'\r': command not found` and the `eque2-code-state` MCP server would not start. Setup strips the CR in place (POSIX `tr`) so the launcher always runs.
- **Fix** — ship a `.gitattributes` (`*.sh text eol=lf`) inside the skill so the wrappers stay LF even if the installed skill is committed to a target repo and re-checked-out on Windows.

## v0.17.4 — 2026-05-29

- **Fix** — `state_update verb: complete` no longer rejects task / scenario / build-check actors. Instead it **triggers Layer-1 structural verification**: the actor advances only if verification passes, preserving the anti-gaming invariant (the agent's claim begins verification; it does not grant trust). This removes the doc/runtime mismatch that caused subagents to fall back to `verb: fail` and corrupt spec state.
- **Fix** — a failed structural verification via `complete` now leaves the task **retryable** (in `building`) rather than driving it to `failed`, so an agent can fix the gap (e.g. a missing test) and call `complete` again. `failed` is reserved for an explicit `verb: fail`.
- **Fix** — the `complete` path now rolls up parent tasks on completion (ADR-14 parity), since it is now the canonical task-completion path.
- **Docs** — `mcp-reference`, `subagent-prompt`, `build-task` and `review-task` updated to describe the trigger behaviour and the fix-and-retry recovery (never fall back to `verb: fail` for a failed verification).

## v0.17.3 — 2026-05-29

- **Fix** — `eque2-code-setup` "Write Files" step now resolves `{project-root}` to the absolute project path for the `--config-path`, `--user-config-path`, `--target`, and `--legacy-dir` arguments to `merge-config.py` / `merge-help-csv.py`. Previously the literal `{project-root}` token was passed through; because the scripts treat those as real filesystem paths (they do not expand the token) and the skill runs with cwd = the skill directory, config was silently written to a stray `.claude/skills/eque2-code-setup/{project-root}/_bmad/…` tree while the real `_bmad/config.yaml` was never touched — and the scripts still exited 0. The token remains literal inside config *values*, as before.
- **Fix** — `merge-config.py` and `merge-help-csv.py` now fail loudly (exit 1, naming the offending flags) if any path argument still contains an unsubstituted `{project-root}` token, so a missed substitution can no longer corrupt an install silently.
- **Fix** — the `state_verify` server reads `EQUE2_PROJECT_ROOT` via Effect `Config` rather than `process.env`, so the project root is resolved through the standard configuration layer.

## v0.17.2 — 2026-05-29

- **Fix** — `state_verify` no longer fails every Layer-1 structural check (`testFileExists`, `testInCommit`, …) for genuinely-complete tasks. The verifier resolved a task's project-root-relative `tests[].file` path against `process.cwd()`, which inside the Docker container is `/app` rather than the bind-mounted project root — so the file and its commit were never found and trust could never advance. `verifyStructural` now resolves test paths against the real project root (`EQUE2_PROJECT_ROOT` → `git rev-parse --show-toplevel` of the spec folder → nearest `.git` → spec folder) and runs `git diff-tree` with that root as its working directory. Root commits are now matched too (`--root`).
- **Fix** — the `state_verify` summary no longer reports a structurally-verified task as `"failed"`. A successful `untrusted → verified` transition had no bucket in `computeVerifySummary` and fell through to the failure count; `verified` (passed Layer-1, awaiting the Layer-2 verdict) is now counted under `pending_review`.

## v0.17.1 — 2026-05-28

- **Fix** — `merge-config.py` no longer clobbers `user_name` (or any other `_CORE_USER_KEYS` value) with stale legacy data. On a re-install, if `config.user.yaml` already has a value for `user_name` or `communication_language`, the legacy `_bmad/core/config.yaml` fallback for that key is discarded before being applied as a default. The user's persisted setting wins.
- **Fix** — `SKILL.md` Step 6 (MCP wrapper registration) now reads `feature_artifacts` from the consolidated `_bmad/config.yaml` under the `eque2-code` section. Previously it tried to read from `_bmad/eque2-code/config.yaml`, which `merge-config.py` deletes earlier in the install — installs were succeeding only because of leftover file state from a prior version.

## v0.17.0 — 2026-05-28

**Trust pipeline rewrite.** Unified structural-then-semantic verification across all three actor types (task, buildCheck, scenario). `state_update <id> complete` is now refused for all three; only `state_verify` can drive an actor to `completed`, which it does internally via `hydrateAndTransition` after Layer-1 structural checks pass. `cmdVerify` advances trust to `verified` (not `pending_review`) on pass; the in-container verifier loop polls at `trustLevel = verified` and promotes to `trusted` via `state_verdict` after Layer-2 semantic review. Trust transitions are now owned exclusively by the orchestrator — `setDoneTrustLevel` removed from machine entry actions; machines own `state.value` only.

**Breaking — agent contract:**

- **`state_update <id> complete` is refused** for task, buildCheck, and scenario actors. Agents must call `state_verify <id>` (with appropriate flags) to drive completion. Returns a clear error pointing at the new path.
- **`skip` verb and `skipped` state removed.** No escape hatch in the trust model — every actor resolves to trusted, rejected, or rolled back via `reset`.
- **`retry` verb removed.** Retry semantics were already covered by the internal `canRetry` guard.
- **`reject` verb branch removed** from `handleParentUpdate` (was unreachable through the public schema anyway).
- **`--skip-structural` flag removed** from `state_verify`. No back door for unsigned evidence.
- Public machine-verb surface shrunk from 6 to **4**: `start | complete | fail | reset`.

**Fix — verification pipeline end-to-end:**

- **Per-spec `.evidence-key` is now mirrored to the host.** `ensureEvidenceKey` writes the same key to both `/data/state.db` (in-container) and `{specFolder}/.evidence-key` (on the host bind-mount, mode 0o600). Unblocks the host-side vitest reporter from signing evidence, which is the root cause behind every `state_verify` returning all structural checks false even after the v0.16.2 auth fix. Closes the verification-pipeline-session-2026-05-28 blocker.
- `loadEvidenceKey` falls back to the host file if SQLite returns None, auto-healing legacy specs after `state_init` re-init.
- `cmdInit` appends `.evidence-key` to the spec folder's `.gitignore` on every init.
- Scenario `cmdVerify` fail-reasons now include resolved absolute paths (testFile, evidence file, expected `.evidence-key` location) so path-mismatch issues are diagnosable from the response alone.

**Fix — parent gating + trust aggregation:**

- `checkParentAutoCompletion` requires all children at `trustLevel = trusted` before the parent transitions to `verified`. Otherwise parent lands at `verifyingSubtasks` and waits. `handleTrustUpdate` now bubbles child trust changes up to the parent — verifier-driven promotions auto-advance the parent.
- `handleParentUpdate(complete)` gates on the same criterion, with a clear error listing untrusted children if rejected.
- `ParentTaskContext.evidence.trustLevel` aggregated as `min(children.trustLevel)` (ordering: suspect < untrusted < pending_review < verified < trusted) on every parent transition. Parents now have a single queryable trust signal.

**Fix — staleness handling:**

- `cmdVerify` demotes `pending_review`/`verified`/`trusted` actors to `untrusted` on re-verification failure (was: no demotion). Trust-graph trigger for `pending_review → untrusted` is now real.
- Scenario `cmdVerify` auto-invokes `cmdCascadeBody` upstream when staleness is detected (`sourceHashMatch=false` or `evidenceFileExists=false` on a previously-trusted scenario), marking supporting tasks `suspect` automatically. No manual `state_cascade` call needed.

**Fix — buildCheck pattern matchers re-enabled:**

- `BuildCheckContext.output` field added; `storeResult`/`storeError` write captured stdout+stderr to context. `isPersistentBuildFailure` pattern matchers (eslint / TypeScript / test-failure detection) now run against real output instead of the empty string they were previously fed.
- `state_verify` accepts `--output=<text>` for buildChecks, threaded into the SUCCESS event payload.

**Verifier loop:**

- The in-container verifier prompt (`verifier/loop.md`) now polls scenarios, tasks, and build checks at `trustLevel = verified`. Per-actor semantic checks: scenarios → assertions vs Gherkin; tasks → commit-diff vs description; buildChecks → command-meaningfulness vs output. Promotes via `state_verdict` to `trusted` or downgrades to `suspect`.

**Docs:**

- New `docs/state-machines.md` — per-actor states, transitions, verbs, trust lifecycle, cross-actor matrix. Single canonical reference for the system.
- `docs/state-machine-gaps.md` and `docs/state-machine-gap-decisions.md` — the 17-gap audit that drove this release plus the per-gap decision record.

**Refactor — cleanup:**

- `setDoneTrustLevel` entry actions removed from `SubtaskMachine`, `BuildCheckStateMachine`, `ScenarioStateMachine`. The misleading "Zero-trust verification: structural + semantic checks passed" reason string is gone; trust transitions now journal naturally through orchestrator code paths.
- `completed`-state docstrings rewritten on all three machines to describe the orchestrator-owned trust model.

## v0.16.2 — 2026-05-28

- **Fix** — Verifier authentication on macOS. v0.16.1 made the failure loud but still
  bind-mounted host credentials, which cannot work on macOS for two reasons: (1)
  Claude Code CLI stores its OAuth token in the macOS Keychain (`Claude Code-credentials`),
  not on disk — there is no filesystem path to bind-mount; (2) `~/Library/Application Support/Claude`
  is the Electron desktop app's data dir, not the CLI. The wrapper now extracts the
  OAuth access token at launch (via `security find-generic-password`) and injects it
  into the container as `CLAUDE_CODE_OAUTH_TOKEN`, dropping the bind-mount approach
  entirely. Verified end-to-end: the in-container verifier authenticates and the loop
  runs stably (vs v0.16.1's persistent "Not logged in" crash-loop).
- **Fix** — Source-priority fallback for the auth token: `CLAUDE_CODE_OAUTH_TOKEN` env,
  `ANTHROPIC_API_KEY` env, macOS Keychain, `~/.claude/.credentials.json`,
  `~/.config/claude/.credentials.json`. Linux/WSL paths still work; macOS now works too.
- **Refactor** — Removed the dead `seed_writable_claude_home` step from the in-container
  supervisor and the `VERIFIER_HOME` redirect from the verifier launcher; both were
  predicated on a bind-mount that no longer exists. Supervisor now logs which credential
  source the verifier is using on startup.

## v0.16.1 — 2026-05-28

- **Fix** — `state_init` now wipes orphaned actors on re-init and resets surviving actors to `not_started`; `InitResponse` carries a new `deleted` count. Re-runs from scratch no longer need a manual reset ceremony.
- **Fix** — `state_update <id> reset` now works on `buildCheck` actors in `completed`. The machine kept `type: 'final'` for its `status: 'done'` contract but lacked a `RESET` transition; build checks were therefore unrecoverable for re-runs.
- **Fix** — `cleanup-legacy.py` preserves `_bmad/<module>/scripts/` during `/eque2-code-setup`. The vitest scenario-state reporter — a runtime artefact, not an installer leftover — is no longer wiped.
- **Fix** — vitest 4 support in the scenario-state reporter. The reporter now implements both `onTestRunEnd` (v4) and `onFinished` (v2/v3) with shape-tolerant file detection (`moduleId` vs `filepath`, `file.task.tasks` vs `file.tasks`), so evidence files are actually written on vitest 4. Without this, `state_verify` failed with misleading "evidence file does not exist" errors.
- **Fix** — Loud failure for the Claude auth-mount pre-flight in `eque2-state-launch.sh`. When Docker Desktop's file-sharing list excludes `~/Library/Application Support/Claude`, the wrapper now surfaces Docker's actual error message and remediation steps on stderr instead of silently falling back to no auth — which previously left the in-container `claude` verifier crash-looping on "Not logged in" and `state_verify` returning misleading "evidence file does not exist".
- **Fix** — Stale container reap before launch: any pre-existing container still bound to this project's encrypted volume is killed before `docker run`, avoiding concurrent SQLite WAL writers across overlapping Claude Code sessions.
- **Fix** — Verifier supervisor seeds a writable copy of the host Claude credentials at `/data/verifier-home/.config/claude` and points the in-container `claude` `$HOME` at it, so the long-running verifier session can refresh tokens (the host bind-mount is read-only by design).
- **Chore** — `module-help.csv` schema cleanup: columns renamed `preceded-by`→`after` and `followed-by`→`before` to match `merge-help-csv.py`'s expected header; obsolete `_meta` row removed. The module now passes Validate Module clean.

## v0.16.0 — 2026-05-28

- **New** — Persistent in-container verifier. The state container now runs under a supervisor entrypoint that keeps a long-lived `claude` session looping (ralph-loop-style Stop hook), polling for scenarios awaiting trust and promoting them via the new `state_verdict` MCP tool. Disable with `EQUE2_VERIFIER=0`.
- **New** — `state_verdict` MCP tool: env-gated trust-write path for the verifier (only registered on the in-container instance via `EQUE2_VERIFIER_TRUST=1`; trust verbs remain off the public MCP surface). 11 tools when enabled, 10 otherwise.
- **New** — Per-spec verifier liveness: `.verifier-status.json` (current scenario, last verdict, count) and `{features-path}/.verifier-heartbeat` for operator visibility.
- **New** — `state_status` and `state_query` return a `corrupt[]` field listing per-actor integrity failures; healthy actors are still returned. One bad snapshot no longer locks the whole spec.
- **Fix** — `state_verify --skip-structural` no longer reports `trusted` for a snapshot it failed to persist (the verify result is now appended only when the state machine transition succeeded).
- **Fix** — Snapshot integrity HMAC is now deep-canonical (recursive key sort + `JSON.stringify`) so the hash survives the Schema encode → SQLite → decode round-trip identically. Snapshots stamped before this fix read cleanly via a legacy-method fallback and are re-stamped on the next mutation — no explicit migration needed.
- **Fix** — Host vitest reporter no longer calls `cmdVerify` in-process. The reporter is purely an evidence producer; verification happens only inside the MCP container. Eliminates the host/container evidence-key split that corrupted HMACs.
- **Fix** — `cmdVerify` (scenario branch) is Layer-1 (structural) only. The dead in-container semantic-template path read is gone; structural pass now parks trust at `pending_review` for the persistent verifier to promote.
- **Fix** — Reporter bundle self-skips the trust-graph build-time scan, eliminating the "build-machine path not found" crash that previously required `EQUE2_GRAPH_SKIP_SCAN=1` as a workaround.
- **Fix** — Integrity-mismatch error hint points at the `state_init` MCP tool (which already re-stamps) instead of a CLI command, keeping the repair inside the container.
- **Refactor** — Dead code removed (`verifyScenarioSemantic`, `resolveSemanticTemplatePath`); health-check `semanticTemplate` subsystem dropped (now meaningless under the new verifier model).

## v0.15.1 — 2026-05-27

- **Fix** — The develop-spec orchestrator now reads the evidence-integrity guardrails (no evidence forging, no `docker exec`, no direct SQLite access) up front on activation, not just the subagents it spawns.
- **Refactor** — Subagent guardrails consolidated into a single canonical `references/guardrails.md`; circuit-breaker and the subagent prompt template now point to it instead of carrying their own copies.

## v0.15.0 — 2026-05-27

- **New** — [CS] detects Jira issue type and activates bug-fix mode for Bug/Defect/Hotfix tickets (root-cause coverage in Stage 5, Figma skipped in Stage 4).
- **New** — Three LLM work offloaded to deterministic scripts: `cs-resolve-test-dir.py` (test-dir resolution), `is-detect-stack.py` (tech-stack detection), `is-verify-styleguide.py` (styleguide mechanical checks).
- **New** — [DS] develop-spec now registered in module-help.csv (visible via `/bmad-help`).
- **New** — Linus greets with an orienting two-line preamble; unrecognised input now routes to the right agent rather than a generic error.
- **New** — Subagent cost warning can be permanently suppressed with "don't show this again".
- **Fix** — Circuit-breaker guardrails now explicitly prohibit `docker exec` into the state container and direct SQLite access; violation warning added.
- **Fix** — Setup: `docker info` daemon-reachability check added (catches multi-user macOS socket permission errors that `docker --version` misses).
- **Fix** — Setup: pre-build notice added for Claude Code auto mode classifier blocking `docker build`.
- **Fix** — Setup: temp clone is now preserved on `docker build` failure instead of being silently deleted.
- **Fix** — First Breath duration estimate corrected to 15–20 minutes throughout.
- **Fix** — Stale `{skillName}` placeholder, "merged PR" description, and CAPABILITIES VM false positive resolved.

## v0.14.1 — 2026-05-27

- **New** — the state container is now observable: `eque2-state-tail.sh` wrapper for live state viewing, an events log, and a sidecar mount fix.
- **New** — `state-md` rendering produces human-readable state snapshots.

## v0.14.0 — 2026-05-21

- **New** — `[DS]` Develop Spec workflow: autonomous build-review-verify loop driven by the `eque2-code-state` MCP server; replaces the retired `execute-verify` CLI workflow.
- **New** — Figma compliance review (three-layer Playwright verification: screenshot, structural, property-level) included as a sub-workflow dispatched from `review-task` when the spec references Figma data.
- **New** — `state_init` called in DS setup stage to bootstrap the encrypted SQLite state from `definitions.json`; idempotent on resume.
- **New** — sub-workflows: `build-task`, `review-task`, `verify-scenario`, `semantic-verify-scenario`, `figma-compliance-review`.
- **New** — `references/mcp-reference.md` documents all nine `eque2-code-state` MCP tools with parameter tables.
- **Chore** — removed "deferred to Day 2" placeholders from `activation-modes.md`, `workflow-dispatch.md`, and create-spec Stage 10 completion menu; `[DS]` is now fully wired.

## v0.13.3 — 2026-05-21

- **New** — `[IS]` (install-styleguide) is now on Linus's dispatch menu; users can invoke it manually to install or refresh coding standards.
- **New** — `[CS]` (create-spec) now checks for coding standards before Stage 1 and auto-invokes `[IS]` if none are found; passes `--headless` to `[IS]` when `[CS]` itself is running headless.
- **Fix** — `install-styleguide` manifest entry now declares `supports-headless: true`.
- **Fix** — stale "Check 5" references in `pre-flight-checks.md` corrected to Check 7.

## v0.13.2 — 2026-05-21

- **Fix** — `module-help.csv` column headers renamed from `after`/`before` to `preceded-by`/`followed-by` to match the BMad installer canonical schema (was triggering a positional-fallback warning on install).
- **Fix** — VM validator (`validate-module.py`) updated to expect `preceded-by`/`followed-by` instead of `after`/`before`.

## v0.13.1 — 2026-05-21

- **Fix** — `cs-generate-definitions.py` was missing from the installed skill in v0.13.0; added to `_bmad-output` so the marketplace sync includes it.
- **Fix** — `install-styleguide` Stage 1 (`01-detect.md`) no longer halts for user input in headless / non-interactive mode; auto-selects `[C] Continue` when `--headless` is set.

## v0.13.0 — 2026-05-21

- **Breaking** — `cs-generate-snapshots.py` retired. Stage 10 of [CS] now emits a single `definitions.json` conforming to `actor-definitions@1` instead of pre-rendered `state/*.json` files. Any spec produced by an earlier version must be re-run through Stage 10 before calling `state_init`.
- **Breaking** — `validate.mjs` deleted. The MCP's structural rejection at `state_init` is the only validation gate; there is no longer a separate CLI validator.
- **New** — `actor-definitions@1` schema is the public spec-workflow → MCP handoff contract. Snapshot schemas (`task-snapshot@1`, etc.) are now internal-only.
- **New** — `state.md` sidecar. The MCP atomically rewrites a human-readable actor-status Markdown table in `{spec_folder}/state.md` after every state-mutating call (`state_init`, `state_update`, `state_verify`, `state_cascade`, `state_done`, `state_metadata`). Advisory only — hand-edits are discarded on the next mutation.
- **New** — MCP `state_init` now constructs initial XState snapshots from `definitions.json` in-memory; no pre-rendered JSON is written to disk.
- Workflow docs updated: Stage 10, CREED, PULSE, activation-modes, pre-flight-checks, checklist, and bmad-manifest all reflect the new pipeline.

## v0.12.4 — 2026-05-15

**Fixed**

- Linus pre-flight no longer reports false-negative blockers for `state_image` and `keychain` on a healthy install.
  - `state_image` previously read the module version from a non-existent `module_version:` key under `eque2-code:` in `_bmad/config.yaml`; the writer stores it as `version:`. The reader now accepts `version:` (preferred) and falls back to `module_version:` for back-compat with any pre-fix configs.
  - `keychain` previously declared failure whenever the `cross-keychain` helper CLI was absent, without consulting the OS keychain itself. The check now falls back to a native query — `security find-generic-password` on macOS, `secret-tool lookup` on Linux — and only blocks when neither the helper nor the native probe finds the entry. Blocker details now include the account hash to aid debugging, and distinguish "no entry" from "cannot verify on this platform".

**Changed**

- `[CS]` Spec mode is no longer interactive-only. The fast-invoke arg parser now disambiguates by shape: anything matching `^[A-Z][A-Z0-9_]*-\d+$` is a Jira key and dispatches to Jira mode; anything else is treated as a path to a prose brief and dispatches to Spec mode (using the existing `--headless:create-spec-from-prose` pipeline). A leading `@` is stripped to match the file-reference convention used elsewhere in Claude tooling. `CS @some-idea.md` and `CS some-idea.md` now route identically. Interactive elicitation remains available when `[CS]` is invoked with no arg.

## v0.12.3 — 2026-05-15

**Changed**

- The Confirm step of SKILL.md now surfaces a prominent restart notice immediately before the module greeting. The `eque2-code-state` MCP server is registered in `~/.claude.json` during install, but the operator's running Claude Code session loaded its MCP roster at startup — the new server isn't visible until Claude Code is restarted. Without the notice, operators ran `/mcp` post-install, saw nothing, and re-debugged Issue 12 manually.

## v0.12.2 — 2026-05-15

**Fixed**

- Ship `package.json` with `cross-keychain` + `tsx` as `devDependencies`, so `pnpm --dir "$SETUP_DIR" install` resolves them inside the skill directory. Without the manifest in place, pnpm walked up to the operator's project root and installed there — the wrapper would then fail to locate the binary (Issues 1/5 from the v0.12.1 postmortem, now closed at the install-payload level).
- SKILL.md step 2 switches from `pnpm add` (mutating, idempotency-hostile) to `pnpm install --ignore-workspace` (idempotent; reuses the shipped manifest; ignores any surrounding `pnpm-workspace.yaml` that would otherwise refuse to treat the skill dir as a standalone install).
- Ship `pnpm-lock.yaml` alongside `package.json` so installs are reproducible across operators.
- `sync-skills.py` (marketplace builder) now excludes `node_modules` and `.git` from the synced skill payload, preventing accidental pollution of the marketplace tree.

## v0.12.1 — 2026-05-15

**Fixed — `/eque2-code-setup` install reliability**

Twelve install-flow defects were reported during a fresh v0.12.0 install (see `/Users/eque2/repos/ai-test/_bmad-output/install-issues.md`). The root causes were (a) ambiguous project-root resolution across SKILL.md / bootstrap / wrapper, (b) the documented `claude mcp add` command registering at the default `--scope local` and using a `-e KEY=VAL` form that the CLI's variadic parser breaks, and (c) `cross-keychain` installed where the wrapper couldn't find it.

- **Wrapper now derives `PROJECT_ROOT` from its own on-disk location** (`SETUP_DIR` minus the `/.claude/skills/eque2-code-setup` suffix). The `$PWD` fallback is gone — `EQUE2_PROJECT_ROOT` remains as an explicit override but is no longer required for the common install layout. If derivation fails, the wrapper exits with a clear FATAL pointing at the override.
- **Wrapper probes `cross-keychain` in a third location** (`$PROJECT_ROOT/node_modules/.bin/cross-keychain`) after `$PATH` and the skill-local install. Belt-and-braces for installs where pnpm ran from the wrong cwd.
- **`keychain-bootstrap.ts` rejects relative `--project-root` values** with `--project-root must be an absolute path`. Defence against the LLM passing the unsubstituted `{project-root}` literal, which `path.resolve()` would silently turn into `cwd/{project-root}`.
- **New `scripts/prune-stale-mcp.py`** sweeps `~/.claude.json` and removes any `eque2-code-state` MCP registrations whose wrapper path no longer exists. Run from SKILL.md step 5.5 so reinstalls at different absolute paths don't accumulate dead entries.
- **SKILL.md "Install State MCP (Docker)" rewritten:**
  - New step 0 defines `PROJECT_ROOT`, `SETUP_DIR`, `MODULE_VERSION`, `IMAGE_TAG` once. Every subsequent snippet uses those variables — no more `./`, `$PWD`, or `{project-root}` token in shell commands.
  - Step 2 installs `cross-keychain` via `pnpm --dir "$SETUP_DIR"` so it lands where the wrapper looks (was: ambiguous `pnpm add` ran in whatever cwd the harness chose).
  - Step 3 clones the source with `--branch "eque2-code-v${MODULE_VERSION}"` (was: `v${MODULE_VERSION}`, which doesn't match the per-module tagging scheme and failed every fresh install).
  - Step 6's `claude mcp add` now uses `--scope user`, `--env=EQUE2_PROJECT_ROOT="$PROJECT_ROOT"` (attached form bypasses the variadic-flag bug), and runs `mcp remove ... || true` first for idempotency. The previous documented command silently registered at `--scope local`, leaving the operator's interactive Claude Code session blind to the server.
- **`Cleanup Legacy Directories`** snippet uses `"$SETUP_DIR/scripts/cleanup-legacy.py"` and `"$PROJECT_ROOT/_bmad"` instead of `./scripts/...` and `{project-root}/...` — the latter forms broke when the harness ran the script from the skill directory.

No public API changes; this is a patch release.

## v0.12.0 — 2026-05-15

**Breaking — state MCP tool names**

- The nine `eque2-code-state` MCP tools are renamed to use underscores instead of slashes: `state/init` → `state_init`, and likewise for `state_status`, `state_done`, `state_query`, `state_next`, `state_update`, `state_verify`, `state_cascade`, `state_metadata`. The slash form violated Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,64}$` and produced "Tool name validation warning" lines on server startup. Any callers issuing literal tool names must update.

**Fixed — `/eque2-code-setup` on macOS**

- `bin/eque2-state-launch.sh` no longer exits 1 under `set -u` when `EQUE2_CLAUDE_AUTH_MOUNT` is unset (previously triggered "unbound variable" on the auth-mount conditional).
- `bin/eque2-state-launch.sh` no longer exits 1 under `set -u` on bash 3.2 (macOS default) when the optional `CLAUDE_AUTH_FLAG` array is empty. Switched to the `${arr[@]+"${arr[@]}"}` workaround.
- The wrapper now pre-flights the Claude auth bind-mount with the existing image. If Docker Desktop's file-sharing config does not include `~/Library/Application Support/Claude` (the default on macOS), the wrapper warns and skips the mount instead of failing the whole MCP launch. The `.cmd` wrapper gets the same probe.
- `scripts/keychain-bootstrap.ts` accepts a `--project-root <path>` flag so the project hash is computed from the same path as the wrapper's runtime hash. Resolves the cwd-mismatch case where the keychain entry was stored under the skill-directory hash but the wrapper looked it up under the project-root hash.
- `scripts/keychain-bootstrap.ts` now resolves the local `cross-keychain` fallback path via `import.meta.url` instead of `__dirname`, so it runs correctly under tsx when the parent `package.json` declares `"type": "module"`.

**Fixed — setup spec**

- `SKILL.md` step 6 registers the MCP at `.claude/skills/eque2-code-setup/bin/eque2-state-launch.sh` (the real install path under the marketplace layout) instead of the legacy `_bmad/eque2-code-setup/...` path.
- `SKILL.md` steps 4 and 5 hash the literal `{project-root}` rather than `$PWD` so the keychain account and Docker volume name stay consistent regardless of the cwd `/eque2-code-setup` happens to run in.

**Known (informational)**

- pnpm 10 skips esbuild's install-time build script (transitive dep of `tsx`) and prints "Ignored build scripts: esbuild". tsx ships a prebuilt binary, so this is harmless. Run `pnpm approve-builds` inside the skill dir if tsx ever fails to start.

## v0.11.0 — 2026-05-15

**Breaking — install model**

- The state MCP server now runs inside a Docker container. **Docker is a hard prerequisite** at both install and runtime. `/eque2-code-setup` halts if `docker` is not on PATH. Greenfield only: existing on-disk JSON state is not migrated.
- A single host-global image (`eque2-state:v<module_version>`) is built once on each developer's machine — the install clones source transiently, runs `docker build`, then discards the clone. Subsequent project installs on the same host re-use the image.
- Each project gets its own Docker named volume (`eque2-state-<sha256(cwd)[:12]>`). Inspect with `docker volume inspect <name>`; reset with `docker volume rm <name>` followed by re-running `/eque2-code-setup`.

**Added — encryption at rest**

- The SQLite state database is encrypted with ChaCha20-Poly1305 page-level AEAD via `better-sqlite3-multiple-ciphers` (aliased over `better-sqlite3` in pnpm overrides). Raw volume bytes are cryptographically opaque to host-side processes that don't hold the master key.
- The master encryption key lives in the OS keychain (macOS Keychain / Linux Secret Service / Windows Credential Vault) via `cross-keychain`. A new wrapper script (`bin/eque2-state-launch.{sh,cmd}`) reads the key from the keychain at every MCP invocation and injects it to the container via env var — the key never appears in `~/.claude/.mcp.json`, in process listings, or on disk in plaintext.
- New `scripts/keychain-bootstrap.ts` does idempotent master-key generation. `/eque2-code-setup --reset-key` rotates the key (and wipes the project's existing volume, since old-key state is unreadable).
- HMAC evidence-keys now live inside the encrypted SQLite database — no more `.evidence-key` files on disk.

**Added — in-container Claude verification worker**

- `cmdVerify`'s semantic step now invokes an interactive `claude` subprocess inside the container instead of the previous `claude -p` headless call, sidestepping the headless billing path. Auth is sourced via a read-only bind-mount of the host's `~/.config/claude` (override via `EQUE2_CLAUDE_AUTH_MOUNT=''` to opt out and `claude login` inside the container).

**Changed — storage layer**

- Replaced filesystem JSON snapshots + mkdir-based lock directory with SQLite (`@effect/sql-sqlite-node@0.45.2`, `@effect/sql@0.44.2`, `@effect/experimental@0.54.6` — pinned exact). cmdX bodies wrapped in `Storage.transaction` for multi-statement atomicity. Journal entries moved from markdown files to SQLite rows. MCP tool surface is preserved byte-for-byte.

**Changed — install + diagnostics**

- Setup skill rewritten with: docker prereq check, keychain reachability check, idempotent clone+build, keychain bootstrap, per-project volume create, MCP registration via the wrapper.
- Linus pre-flight (`scripts/preflight-check.py`) extended with `docker` / `state_image` / `keychain` blocker-severity checks. Module-version reader now prefers PyYAML with a hand-roll fallback.
- Project bind-mount scope is `${PWD}:${PWD}:ro` by default; override via `EQUE2_PROJECT_MOUNT=<absolute-path>` for stricter scoping.

**Changed — tooling**

- Marketplace skill (`eq2-build-marketplace`) no longer syncs `servers/state-server.mjs` — the server ships inside the Docker image, not as a marketplace artefact.
- `bmad-module-builder` VM now recognises the `_meta` row convention used across BMad modules — eliminates false-positive `orphan-entry` and `missing-field` findings.
- `state.ts` ESM main-guard tightened so the bundled CLI block doesn't fire when bundled into `state-server.mjs`. Trust-graph trigger-source scan made env-skippable (`EQUE2_GRAPH_SKIP_SCAN=1`) for production bundles where source `.ts` files are inlined into the bundle and no longer exist on disk.
- `cmdInit`'s legacy state-name migration loop removed — unreachable since the modern `TaskSnapshot` Schema rejects legacy state values before the loop is reached.

**Tests**

- 12 new tests: claude-worker mock suite (10), encrypted round-trip across dispose+reinit, cmdX end-to-end via SQLite, transaction rollback. Full repo suite: **3416 passing**.

**Docs**

- New operator runbook at `docs/state-mcp-docker.md` covering volume layout, reset, manual rebuild, troubleshooting, security boundaries, and the `EQUE2_PROJECT_MOUNT` and `--reset-key` escape hatches.

## v0.10.1 — 2026-05-14

**Fixed**

- The runtime bundles (`state-server.mjs`, `validate.mjs`, `scenario-state-reporter.mjs`) and JSON schemas now actually ship inside the setup skill. The v0.10.0 marketplace snapshot was missing them in `skills/eque2-code-setup/{servers,scripts,schemas}/`, so `npx bmad-method install --custom-source ...` left target repos without the MCP server's runtime payload. Resync committed.
- Pre-push hook tests pass (was 14 pre-existing failures): `worker-lock` log message aligned with its singleton-lock test, three bug-zip regression tests gracefully skip when the local `bug/eque2-state (2).zip` fixture is absent, and five tests whose fixtures were intentionally retired (stall-detector config, installers byte-identity, legacy-test-compliance-removal sibling spec) are deleted.

**Docs**

- README install command now reads `npx bmad-method install --directory . --modules bmm,bmb,cis --custom-source https://github.com/eque2/eque2-code --tools claude-code --yes`. The previous version omitted `--modules`, so target repos got the Eque2 marketplace skills but no BMad core agents/workflows.

**Internal**

- `@eque2/graph` error variants refactored from manual `{_tag, ...}` object literals to `Data.TaggedError` classes (`DanglingEdge`, `UnroutedEdge`, `TriggerArtefactMissing`, `OrphanVertex`, `DuplicateEdge`, `DuplicateVertex`, `StrayTrigger`, `MalformedGap`).
- MCP tool handler's early-return paths refactored to `Effect.gen` instead of `Promise.resolve(...)` wrappers.
- ESLint ignore list updated to skip `installers.retired/**`, `_bmad-output/**/*.mjs`, and `skills/**/*.mjs` (compiled bundles shouldn't be linted; their `.ts` sources are).
- `.claude/CLAUDE.md` adds a section flagging `installers.retired/` as off-radar.

## v0.10.0 — 2026-05-12

First release under the BMad-method marketplace model (`npx bmad-method install --custom-source ...`). See commit history for the migration details prior to the introduction of this changelog.

- **Breaking** — `state.mjs` CLI removed. State management is now exclusive to the `eque2-code-state` MCP server (nine tools: `state/init`, `state/status`, `state/done`, `state/query`, `state/next`, `state/update`, `state/verify`, `state/cascade`, `state/metadata`).
- **Breaking** — bespoke `installers/bmad/<module>/` install flow retired in favour of BMad-method's marketplace model. The previous `bash <(gh api …)` install command is no longer maintained.
- **Breaking** — runtime bundles (`validate.mjs`, `scenario-state-reporter.mjs`, `state-server.mjs`) and JSON schemas now ship inside the setup skill at `skills/eque2-code-setup/{scripts,servers,schemas}/` rather than `_bmad/eque2-code/`.
- Feature: stdio MCP server (`eque2-code-state`) wrapping the state engine in-process.
- Feature: `@eque2/graph` package with `defineGraph` smart constructor and structural validator.
- Feature: Linus is now a BMad-compliant agent skill with customization surface, persistent_facts, on_complete hooks, sanctum, pulse, and creed.
- Feature: `scenario-state-reporter` calls `cmdVerify` in-process (drops `execSync` + the `STATE_CLI` env var).
