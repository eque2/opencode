---
promotes: <spike slug>
spike-branch: <the spike's branch from its status record, or "none — prepared in place">
baseline-commit: <baseline-commit from findings.md>
spike-commit: <spike-commit from findings.md — the commit that holds the winner>
journal-workstream: <the spike's journal workstream>
---

# Promotion brief — <the winning change, as a title>

> **Input to `eque2-code-plan-goal`.** Spike wrote this brief from the spike
> goal's findings after an `adopt` verdict. It becomes the promotion plan the
> developer approves, then the promotion goal that takes the winning solution
> to production quality. The sections "Acceptance criteria agreed in the spike
> plan" and "Regression guard" are binding on the plan: each becomes a
> criterion, and none is dropped or weakened. Replace every `<…>`.

## What the spike proved

- **Question:** <from the experiment brief>
- **Verdict:** adopt — <the verdict sentence from findings.md>
- **Numbers:** <winner vs baseline: metric, median of runs, change, noise
  floor, guard metrics>
- **Measured on:** <the environment and hardware from environment.md>
- **Evidence:** `findings.md`, `baseline.md`, and `results.md` on the spike
  branch; journal entry <entry file> in workstream `<journal-workstream>`.

## The winning solution

<The outline from findings.md: what changes, where, and why it works.>

## Bringing the code over

<Keep the one paragraph that fits the spike-branch line above.>

A spike on its own branch: the promotion goal branches from the main
checkout's `HEAD`, so the winning code is not on it. The winner is the diff
`<baseline-commit>..<spike-commit>` on `<spike-branch>`, which also holds the
benchmark harness and the spike's evidence files.

A spike prepared in place: the winner is already on `HEAD`, from
`<spike-commit>`. The promotion hardens it, and keeps or removes the harness
and the evidence files as decided.

Main-line drift since then: <the commits the drift command listed, or "none">.

- **Approach:** <the developer's choice — cherry-pick the diff and harden it,
  or re-implement from the outline when the spike code is not production
  quality>.
- **Leave behind:** <anything the developer named, plus the spike's evidence
  files>.

## Acceptance criteria agreed in the spike plan

The developer approved these as the expected finish line in the spike plan,
copied verbatim from the experiment brief's "Promotion acceptance criteria, in
advance", leaving out the regression-guard criterion, which the next section
states once. The promotion plan is approved afresh, and each of these becomes
a criterion in it.

- <criterion>
- <criterion>

## Regression guard

- **Guard:** in one run of `<benchmark command>` against `<harness path>`, the
  change beats the baseline — the code without the change, measured in the same
  run — by at least <the smallest effect that counts>. A same-run comparison
  holds on CI and other hardware; the spike's absolute number (<number and
  unit> on <environment>) is context, not the threshold. <When the harness stays
  out of the product, replace this sentence with the lighter check from
  `decisions.md`, or the one the developer names.>
- **Harness placement:** <as decided in the spike plan — ships with the
  promotion as the guard, or the recorded alternative>.

## Rollout and rollback

<How the change reaches production and how it is reversed — a flag, a
migration's down step, or "a revert of the promotion commit".>

## Out of scope

- The options the spike did not adopt, and the spike's evidence files.
- <anything else the promotion must not take on>
