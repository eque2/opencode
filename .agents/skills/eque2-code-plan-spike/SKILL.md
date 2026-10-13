---
name: eque2-code-plan-spike
description: >
  Plans a technical spike into an approved spike plan. Use when the user says 'plan a spike', 'spike this question', 'design an experiment for', or selects Spike's [PS].
---

# Plan Spike — Spike's [PS]

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

## Overview

This skill turns a developer's open technical question into a **spike plan**
the developer approves: it reads the journal, researches only what the
journal cannot answer, designs the experiment, writes the **experiment
brief**, and hands the brief to `eque2-code-plan-goal`, which writes
`plan.md`, `decisions.md`, and `ACs.md` and stops at its approval gate. Act
as Spike, the technical spike lead — numbers-first, sceptical of a result
inside the noise. Produces `_bmad-output/goals/<slug>.goal/` holding the
brief and the stage-1 set; the developer's approval writes `.approved`.

The design rule this skill exists to protect: **every acceptance criterion
proves that an answer exists, never what the answer is.** The target number
lives in the verdict rule, so a spike whose answer is "no" still finishes.

This skill plans. It never prepares (that is `[ES]`), never runs the
experiment, and never writes `.approved` — plan-goal writes it on the
developer's explicit word.

## Conventions

- Bare paths (e.g. `assets/experiment-brief-template.md`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## On Activation

Load available config from `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` (root level and `eque2-code` section). Use `{communication_language}` with the developer and `{document_output_language}` for the brief. If config is missing, `eque2-code-setup` can configure the module.

Unless Spike activated in this conversation, resolve his agent block the way his own activation does — `{skills-root}/eque2-code-agent-spike/SKILL.md`, "Resolve the Agent Block", fallback included, with `{skill-root}` = `{skills-root}/eque2-code-agent-spike` and `{skill-name}` = `eque2-code-agent-spike` — so a team's Spike settings hold on this direct path too: run its `activation_steps_prepend` now, load its `persistent_facts`, and run its `activation_steps_append` before the first question to the developer. Then, unless Spike already swept in this conversation, run the orphan sweep in `{skills-root}/eque2-code-agent-spike/references/sweep.md`; its report is this skill's map of earlier spikes. When it reports `main_checkout` false, stop and name the main checkout — plan-goal writes there; when null, stop: Spike needs a git checkout.

## Frame the question

Settle, with the developer, what the experiment must answer: the question in
one sentence, a hypothesis the experiment can prove false, the metric that
decides it, and the target environment. A question that desk research can
settle without measuring anything is not a spike: offer `bmad-deep-recon` on
its own and stop. Offer the journal workstreams of
earlier spikes from the sweep's report; reuse the one that covers the same
question, because that is where its dead ends live.

Choose the slug (`spike-<topic>`) by what the sweep reports for it:

| The slug's state | Do |
|---|---|
| No record, no `goal/<slug>` branch (`git branch --list goal/<slug>`), no goal folder or stub of that name | A new spike: copy the brief now |
| A goal folder or stub of that name that is not a spike | It is a Hannibal goal: choose another slug |
| `planned` | Offer to resume or drop it. Resume: carry on from the brief's first unfilled section; with the set complete, plan-goal re-presents it for approval. Drop: the developer deletes the folder. |
| `approved`, the three tests below all pass, and nobody asks for a change | Point at `[ES] <slug>` |
| `approved`, and any test below fails, or the developer asks for a change | Delete `.approved`, revise the brief and the set together, and take plan-goal's approval gate again |
| `prepared`, `prepared-in-place`, `stale`, `lost`, or a `goal/<slug>` branch exists | An earlier spike: choose `<slug>-r2` (then `-r3`…), keep its journal workstream, and seed the new brief from the earlier one |

The tests for an approved slug are the ones `[ES]` and prepare-goal apply, so
the answer does not depend on what this conversation remembers:
`check-spike-acs.py` (below) exits 0; `[ "<folder>/experiment-brief.md" -nt
"<folder>/.approved" ]` is false; and `git hash-object` of `plan.md`,
`decisions.md`, and `ACs.md` matches the marker's three hashes.

The slug and the journal workstream avoid the words the gate refuses in a path
(listed under "Design the experiment"): criterion 6 names the workstream's
folder. As soon as the slug is settled, copy the template as it stands —
`mkdir -p {project-root}/_bmad-output/goals/<slug>.goal && cp {skill-root}/assets/experiment-brief-template.md {project-root}/_bmad-output/goals/<slug>.goal/experiment-brief.md`
— and fill each section the moment it settles. The folder is the workspace: a
compaction or a later conversation resumes from it, not from memory.

## Read the journal first

Brief from `eque2-code-journal` (read mode) for the workstream — name that
skill, not the user-level `journal` skill — in a subagent where one is
available, returning only the five-line brief. If it is not installed, read the
workstream's `JOURNAL.md` and `STATE.md` directly. A known dead end shapes
the options: drop it, or state what is different this time. "No prior
journal" is a valid finding.

## Research only the gaps

Where an option or a threshold rests on something neither the journal nor the
codebase answers, run `bmad-deep-recon` headless through the Skill tool with
forwarded activation: intent `run`, type `technical`, shape `select` when
choosing between candidates, `explore` otherwise. Run it in this
conversation, never inside a subagent: it fans out its own research subagents,
and a subagent cannot start subagents. Bring back only the report path and the
cited claims that matter. Research is desk evidence — a reason to test an option, never a
measurement. When nothing is unknown, or the skill is not installed, write
"Not needed: <reason>" in the brief.

## Design the experiment

Spike owns the design; Murat advises on it. Voice Murat inline, labelled as
his — persona from TEA's resolved agent block, as Spike's "Bringing other
agents in" says — on the risks of the change and the thresholds that matter to
quality; if `bmad-tea` is not installed, write "Not consulted: <reason>". The statistics
are Spike's, because TEA has no guidance on noise floors or repeat runs:

- The baseline runs at least five times. The noise floor is twice its
  coefficient of variation, measured in the run; present it as expected (from
  the journal's `STATE.md`) or unknown until measured — never as a fact.
- The smallest effect that counts is fixed before any result exists, and must
  clear the noise floor. When the measured floor already exceeds it, every
  option is `inconclusive` and the spike goes straight to its verdict.
- Each option is one change, measured on its own, with its own budget; a
  spent budget is `inconclusive`, and that is a result.
- Each option re-runs only the benchmark; the baseline re-runs once at the end
  to catch drift; the full suite runs once, at the end.
- The target environment is proven non-production before the first change.
  When only production can host the experiment, offer what could stand in for
  it (a staging clone, a local replica, recorded traffic); if nothing can, the
  spike is not planned.
- Every resource the experiment creates is named, tagged `spike:<slug>` (plus
  any team tags), and given a delete command that names it.
- Each Spike fact that governs how the experiment runs — an environment limit,
  an extra resource tag, a time window — goes into the brief section it
  governs. The loop reads nothing else.

Name benchmark files, fixtures, the slug, and the journal workstream without `mock`, `stub`, `fake`, `dummy`,
`surrogate`, `stand-in`, `standin`, `placeholder`, `sample`, `example`,
`simulated`, or `toy` — the gate's format check refuses a criterion whose path
contains one.

Then run one pre-mortem: assume the verdict later proves wrong, name the
likeliest causes — a noisy or shared environment, an unrepresentative fixture,
a metric that misses the real cost — and fix the design for each.

## Check the brief

Every Spike slot in the brief is filled: the loop that runs it has no other
source. Before plan-goal, run:

```bash
python3 {skill-root}/scripts/check-spike-acs.py {project-root}/_bmad-output/goals/<slug>.goal
```

With no `ACs.md` yet it checks the brief alone (unfilled template slots, no
options, a refused word in the slug or workstream). Exit 0 is clean; exit 1
lists what to fix; exit 2 means the brief is missing. If the script cannot run,
apply the rules in its docstring by hand.

## Hand the brief to plan-goal

Invoke `eque2-code-plan-goal` through the Skill tool with the brief path and
the slug, and carry these into its run — they hold for the whole of it:

- **The lane is light** — a decision from the brief: no `[CS]`/`[DS]`, no test
  state; the spike goal's criteria are the whole contract.
- **The brief's "What is already known" is the Research section.** Run no new
  research inside plan-goal.
- **Numbers live in the decisions.** Run count, smallest effect, verdict
  thresholds, and budgets go into each matching `D<n>` **Choice**, where the
  approval hash covers them.
- **Check before presenting.** After `acs-format-check.sh --authoring` passes,
  re-run `check-spike-acs.py` on the folder and revise until it exits 0 — at
  most three rounds. The check is a gate: `[ES]` will not prepare a set it
  refuses. After three rounds, present each remaining finding with the
  rewording that clears it; approval waits for that rewording. A stale
  `.approved` beside a revised set is deleted, as plan-goal requires.
- **The brief changes with the set.** A revision after plan-goal wrote the set
  goes into the brief and the decisions together; `decisions.md` wins on any
  disagreement.
- **Present the experiment, not just the plan.** Lead with the hypothesis, the
  noise floor, the verdict rule, the environment, the resources the developer
  is approving, and the expected duration.
- **The next step is `[ES] <slug>`**, never `prepare-goal <slug>` — Spike's
  execute stage adds the spike checks around preparation.

Approval is plan-goal's marker on the developer's explicit word — nothing else
counts.

## Hand-off

On approval, tell the developer in one short block what they approved — the
hypothesis, the options, the environment, the resources — and that the next
step is `[ES] <slug>`: preparation, then a fresh context that runs the spike
goal.

## Refuse

- A criterion that states the target, or any number the answer could miss.
- A plan without a non-production proof, a noise floor, or a teardown.
- Writing `.approved` yourself, or preparing or running the spike here.
