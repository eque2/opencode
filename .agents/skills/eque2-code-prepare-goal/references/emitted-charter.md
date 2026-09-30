# Phase E — the stamp blocks (verbatim shapes)

These are the directives and templates Phase E folds into the input file.
They are the *deliverable's* wording, so they must survive being read by a
downstream agent that was never in this conversation — and possibly a
different agent from the one that prepared the charter. Everything here is
agent-neutral by design; where a Claude Code command appears, a one-line
agent note names the equivalent (see `references/agent-mapping.md`).

Pull the exact headless invocation strings from the eque2-code Linus skill
at authoring time (its `references/pulse.md` task table) rather than
trusting this file, in case they have moved.

**The full edit** the charter receives: the auto-start banner (§0) at the
very top, the status header (§1), the
Build-via directive at the very top (§1a) with the enforcement block when
eque2-code, the YOLO directive directly under it (§1b), a frontmatter link
block (SPEC path — a real produced file now — journal dir, `STATE.md`,
adopted companions, refreshed project docs), original prose preserved
(strike through only what contradicts a resolved decision), a
Resolved-decisions section, the story list (Phase 5) and test sketch
(Phase 6) as bullets, the observability-to-wire list (Phase 3), a
Ready-to-execute commands section (per-epic `[DS]` chain when eque2-code,
each with the agent note), a Contract-review note (Phase R), a "What this
skill did NOT do" footer, and the Done-when checklist (§10).

**Phase E also writes two files that are not the charter:** the goal
folder's `CLAUDE.md` and `AGENTS.md` auto-start instructions (body in
`references/phases.md`, Phase E). They are what make the folder execute
itself when a fresh context opens it, and they are written ONLY when
`goal.md` and `ACs.md` both landed.

## §0. Auto-start banner — the VERY first lines of `goal.md`

Above everything, including the status header. Anyone who opens this file
— because the user named the folder, pasted the path, or attached it — is
reading an instruction, not a description:

```
> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.
```

The same sentence goes at the top of `ACs.md`, and in the folder's
`CLAUDE.md` / `AGENTS.md` (Phase E in `references/phases.md`). Four
copies of one instruction is deliberate: each covers a different way a
reader arrives — cwd, the charter, the criteria file, the folder listing
— and an instruction that is only in the one the reader did not open is
not an instruction.

## §0a. Worktree-switch line — MANDATORY in `CLAUDE.md` / `AGENTS.md`

The folder lives in the worktree Phase W created, so a reader pointed at
it from the main checkout must move before doing anything. Stamp this
directly under the auto-start instruction in the folder's `CLAUDE.md`
and `AGENTS.md`, with `<worktree-root>` replaced by the **absolute path
resolved from disk at Phase E time** — never a template path:

```
> **Switch into this goal's worktree first.** This folder lives in the
> worktree `<worktree-root>` (branch `goal/<slug>`). If your session's
> working checkout is not that worktree, switch into it BEFORE running
> the starter — Claude Code: `EnterWorktree` with
> `path: <worktree-root>`; other agents: open a fresh context with that
> root as the working directory. The starter, the stop gate, and every
> turn of the work must run inside the worktree; run from the main
> checkout they bind the gate to the wrong tree and edit files this
> goal's branch never sees. Being pointed at this path IS the
> instruction to switch — do not ask.
```

Goals prepared in place (the recorded no-worktree fallback) omit this
block — there is nothing to switch into.

## §1. Status header

```
> **GOAL-READY YYYY-MM-DD** — <workstream slug>, spec-backed,
> adversarially reviewed; SPEC produced this run. Drive with your agent's
> completion loop (`pursue-goal`, which binds the stop gate). See SPEC + journal
> below for full contract.
```

## §1a. Build-via directive — MANDATORY, at the very top

Stamp the mechanism **Phase 0.5 resolved** — not a fixed string. Because
this skill RUNS create-spec (`[CS]`) during its own run, the SPEC already
exists (linked in the frontmatter block). So the directive points
downstream at **build** (`[DS]`), and reserves `[CS]` for *re-spec* only.

### When eque2-code is the resolved mechanism (PREFERRED)

```
> **Build via eque2-code (evidence-gated).** The SPEC for this contract
> was produced during goal-prep and is linked in the frontmatter block
> below — you do NOT need to create it. To IMPLEMENT it, run `[DS]`
> develop-spec — the autonomous build-verify loop gated by the state CLI's
> `verify` verb:
> `/eque2-code-agent-linus --headless:develop-spec <spec-slug>` (or
> `--headless:ship <spec-slug>` for the DS→ET→PR chain). Multiple epics →
> one `[DS]` per epic spec, in dependency order. Full verification is the
> DEFAULT — do NOT pass suppression flags (`--no-party` etc.). If
> requirements have SHIFTED since goal-prep, re-spec first with `[CS]`
> (`--headless:create-spec-from-prose <this-file>`), then `[DS]`.
>
> _Agent note — Claude Code: run the `[DS]`/`[CS]` skills above. Other
> agents (e.g. Codex): drive the state + tests CLI build-verify loop
> directly (`state.mjs`, `tests-cli.mjs`) per
> `references/agent-mapping.md`, or an installed create-spec/develop-spec
> prompt. The gate is enforced by the scripts, so the safety is the same._
>
> **⛔ BYPASSING THIS PIPELINE IS ABSOLUTELY FORBIDDEN.** Because
> eque2-code is the resolved mechanism, every artefact of this contract
> MUST be produced through the state machine and the tests CLI's
> verification lifecycle
> (`building → awaiting_verification → verified_passing`). It is FORBIDDEN
> to:
> - hand-write the implementation or the tests instead of running the
>   gated build-verify loop;
> - skip, stub, fake, or route around the state CLI's `init` / `update` /
>   `verify` / `done` verbs or the tests CLI's gating;
> - self-certify a "Done when" checkbox with tests the state machine never
>   independently verified;
> - substitute weaker tests (isolated component renders, seeded query
>   caches, mocked APIs, reduced-region assertions) for the pipeline's
>   gated verification;
> - optimise for the Stop-hook checklist while skipping the process that
>   earns it. The checklist grades *outputs*; the pipeline is what makes
>   those outputs real. Bypassing it produces green gates over broken
>   software — the exact failure this mechanism exists to prevent.
>
> If the pipeline genuinely cannot run (agents not installed, a tool
> errors, an external precondition missing), you STOP and REPORT it as a
> blocker. You do NOT silently substitute your own approach. Deviating
> from this mechanism without surfacing it FIRST and getting the owner's
> go-ahead is itself a violation, regardless of how the result looks.
>
> **⚠️ ENFORCEMENT — this is not a guideline.** Any agent caught bypassing
> the eque2-code pipeline — building around the state machine, faking or
> skipping verification, or self-certifying unverified work as "done" —
> WILL BE SWITCHED OFF. Non-compliance ends the agent. Follow the pipeline
> or escalate the blocker; there is no third option.
```

The `⛔` and `⚠️ ENFORCEMENT` blocks are a MANDATORY part of the stamp when
eque2-code is the resolved mechanism. Never omit, soften, or reword them —
they are about the *pipeline*, so they stay verbatim whatever agent runs
the charter. (The #1 historical failure of downstream runs is an agent
silently bypassing the state machine and self-certifying a green checklist
over broken software; this prohibition + the switch-off threat are the
countermeasure.)

### Fallback, when eque2-code is NOT installed

```
> **Build via BMAD.** The SPEC was produced during goal-prep (linked in
> the frontmatter below). To IMPLEMENT it, use `bmad-testarch-atdd` →
> `bmad-build` → `bmad-code-review`. To re-spec
> if requirements shifted, use `bmad-spec`. Do NOT pause to ask *how* to
> build; this is the answer.
>
> _Agent note — other agents: follow the equivalent create-story →
> failing-tests → implement → review procedure; see
> `references/agent-mapping.md`._
```

## §1b. Run-autonomously (YOLO) directive — MANDATORY, at the very top

Stamp on EVERY file this skill edits, verbatim — adapt only the
parenthetical compute scope to the workstream:

```
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
```

## §10. Done-when checklist — MANDATORY

The acceptance contract. It is emitted to its **own file, `X.goal/ACs.md`**,
and `goal.md` links it as `./ACs.md` — a relative link, so the folder still
moves as a unit.

**Why a separate file:** the gate reads and re-reads this checklist on every
turn end, and each tick has to carry its evidence. A checklist buried in the
middle of a prose charter cannot be parsed, counted, or ticked without
rewriting the charter around it.

`goal.md` therefore carries the pointer and the summary, never a second copy
of the boxes. Two copies drift, and a drifted acceptance contract means the
charter says one thing and the gate enforces another.

MARKDOWN checkboxes (not the predecessor's YAML `type: script` / `check:`
schema): each a single, falsifiable, natural-language OUTCOME whose EVIDENCE
the run surfaces — real command output, a recorded verdict, a queried
registry/report, a printed artefact id — never a brittle single-file path and
never something only an external tool could check.

**The two halves of the reversal, stated together so neither is "fixed" back
by a later reader:** the loop mechanism is the **stop hook**, not a host
agent's built-in goal command; and the criteria stay **natural-language
markdown checkboxes**, not machine-checkable script conditions. Both are
deliberate. Reverting either one breaks the other.

Every tick MUST carry an indented `- evidence:` line; every unticked item
MUST carry an indented `- explanation:` line. A tick with no evidence is
refused by the gate as `ticked-without-evidence` — a self-certified tick
costs a turn and gains nothing. The full lexical rules are
`references/acs-format.md`.

Mandatory items: the codebase's FULL quality gate (discovered via
`scripts/detect-quality-gate.py`, not assumed — lint, type-check, tests,
plus any format/CI/Makefile gate, each shown passing via real output, tests
covering success + boundary/empty + failure modes); the binding verdict
(recorded in report + `STATE.md`, grounded in the REAL highest-fidelity
run); the canary gate (if it fans out); and one item per CAP success
condition where possible.

Template for **`X.goal/ACs.md`** (adapt the items — MARKDOWN, not YAML):

```markdown
# Done when (verification checklist — completion contract)

- [ ] The codebase quality gate passes end-to-end — **lint, type-check,
      and the full <feature> test suite** (the project's real gate,
      discovered not assumed) — shown by real run output (e.g.
      `uv run ruff check .` clean, `uv run mypy <pkg>` / `pyright` clean,
      `uv run pytest -k "<feature>"` 0 failures), with the tests covering
      the success path, the empty/zero-result and boundary cases, and the
      failure modes.
      - explanation: <why it is not met yet>
- [ ] <one falsifiable outcome per CAP success condition — e.g. "every
      emitted pair's model-id matches v2-tb{h}-meta-{start}-{end},
      confirmed by reading the registry, not by trusting it">
      - explanation: <why it is not met yet>
- [ ] The binding verdict is recorded in the report + `STATE.md` and is
      grounded in the REAL highest-fidelity run (full universe / sanctioned
      venue), not a reduced or local sample.
      - explanation: <why it is not met yet>
- [ ] <if the workstream fans out> Before the fleet launched, the code was
      tested AND one small real subset ran end-to-end in the LIVE
      environment and was confirmed good; the full fan-out followed only
      that passing canary.
      - explanation: <why it is not met yet>
```

Ticked, it carries its evidence instead:

```markdown
- [x] The codebase quality gate passes end-to-end — lint, type-check, tests
      - evidence: `uv run pytest -k "<feature>"` → 128 passed, 0 failed;
        `uv run ruff check .` → clean; `uv run mypy <pkg>` → clean
```

And in `goal.md`, the pointer — never a second copy of the boxes:

```markdown
## Done when

The acceptance contract for this workstream is [`./ACs.md`](./ACs.md)
(<N> criteria). It is the file the gate reads; this charter does not
restate it. A criterion tagged `[D<n>]` proves an approved technical
decision in [`./decisions.md`](./decisions.md) — build to the decision,
do not re-decide it.

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
<this folder>
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
```
