---
spike: <slug — kebab-case, e.g. spike-mcp-query-speed>
journal-workstream: <eque2-code-journal workstream slug — reused by every spike on this question>
---

# Experiment brief — <the question, as a title>

> **Input to `eque2-code-plan-goal`.** Spike wrote this brief into the spike
> goal folder, where plan-goal takes it as its input and prepare-goal carries
> it into the worktree, so everything the spike loop needs is in this file. The
> sections "Decisions for plan-goal" and "Spike goal acceptance criteria" are
> binding on the plan. Copy this template as it stands and fill Spike's slots:
> replace every `<…>` outside the fenced blocks. The italic lines are guidance
> the loop also reads — leave them. The fenced ledger and findings blocks are
> formats the loop fills at run time — keep them as they are. If this brief and
> `decisions.md` disagree, `decisions.md` wins: it is what the developer
> approved. A change after approval goes into both, and through plan-goal's
> approval gate again.

## Question

<The developer's question in one sentence, e.g. "Can we make the state MCP
server faster by changing its queries?">

## Hypothesis

<One sentence that the experiment can prove false.>

## What is already known

- **Journal** (`eque2-code-journal`, workstream `<journal-workstream>`):
  <last verdict and date; dead ends this spike will not repeat, or why one is
  being retried under different conditions; "no prior journal" if none>.
- **Research** (`bmad-deep-recon`, <type and shape, or "not run">): <the report
  path and the cited claims a decision rests on, each with its source — or why
  the journal and the codebase made research unnecessary>. Desk evidence, not
  measurements — every claim here is a reason to test, never a result.
- **Murat** (TEA): <his view on risk and thresholds, labelled as his — or why
  he was not consulted, for example `bmad-tea` not installed>.

## Options

*Each option is one change, tested on its own against the baseline. Give each
an id — the checker reads `### O<n>:` headings.*

### O1: <name>

- **Change:** <what is changed, and where>
- **Why it might work:** <the evidence or reasoning>
- **Budget:** <wall-clock time or number of attempts>. When the budget is
  spent, O1 is `inconclusive` — that is a result, not a failure.

### O2: <name>

- **Change:** <what is changed, and where>
- **Why it might work:** <the evidence or reasoning>
- **Budget:** <wall-clock time or number of attempts>

## Metric and noise floor

- **Metric:** <name, unit, and direction — e.g. p95 latency of `state.get`, ms,
  lower is better>.
- **Measured by:** `<benchmark command>` against `<benchmark harness path>`.
  *No path or fixture name may contain mock, stub, fake, dummy, surrogate,
  stand-in, standin, placeholder, sample, example, simulated, or toy — the
  gate's format check refuses a criterion whose path contains one.*
- **Baseline runs:** <run count — at least 5>. Variance is recorded as the coefficient
  of variation (standard deviation ÷ mean) and the min–max range.
- **Noise floor:** twice the baseline's coefficient of variation, measured in
  the run. Expected: <from the journal's `STATE.md` or a pilot run, or "unknown
  until measured">.
- **Smallest effect that counts:** <number and unit>, fixed now, before any
  result exists. It must clear the noise floor. If the baseline varies by 15%,
  a 10% win is noise.
- **Guard metrics:** <metrics that must not get worse, e.g. error rate, memory;
  or "none">.
- **Statistics come from the harness.** It prints the median, standard
  deviation, and coefficient of variation of each run set, and each option's
  change against the baseline, as JSON; no number in the findings is computed
  by hand.

## Verdict rule

*The target number lives here and nowhere else. No acceptance criterion states
it, so the loop can finish whichever way the answer falls.*

- **adopt** — <e.g. an option improves the metric by at least the smallest
  effect that counts, repeatably, no guard metric gets worse, and the full suite
  passes on it>. When two options clear it, the larger median effect wins;
  within the noise floor of each other, the simpler change wins.
- **reject** — <e.g. every option was measured and none clears the smallest
  effect that counts>.
- **inconclusive** — <e.g. the noise floor is wider than the smallest effect
  that counts, a budget ran out before an option could be measured, or the
  closing baseline drifted beyond the noise floor>.

## Test design

- **Baseline once.** Measure it <run count> times, before any change, and pin it to
  the commit SHA and a hash of the fixture data (`<fixture path>`). Record it in
  `baseline.md` in this folder. Run benchmarks with nothing else loading the
  machine.
- **Early exit.** If the measured noise floor already exceeds the smallest
  effect that counts, no option can be told apart from noise: mark every option
  `inconclusive` with that reason and go to the verdict.
- **Each option re-runs only the benchmark**, never the full suite, against
  the pinned baseline. Record each in `results.md` in this folder, one section
  per option, with its commit on the spike branch.
- **Closing drift check.** Re-run the baseline once after the options. A
  drift beyond the noise floor makes the verdict `inconclusive`.
- **The full suite runs once, at the end** — on the winner when the verdict is
  adopt; on the baseline plus the harness otherwise. Long testing phases do not
  repeat.
- **Expected duration:** <baseline runs + options + closing checks, in hours>.
  A sanctioned wait covers at most 24 hours in all, so a longer spike splits
  into follow-up spikes.
- **Long runs.** Keep the turn alive and wait inside it. A run that must
  outlast turns declares a sanctioned wait: one line, an epoch-second deadline,
  in `.goal-gate/WAIT` at the worktree root (the gate allows 24 hours in all).
  The gate ends a run that shows no tick, edit, or commit for 16 turns.

## Environment and resources

- **Target environment:** <where the experiment runs>.
- **Proof it is not production:** <the check that proves it, e.g. the
  connection string's host, an account id, a namespace label>. Record the
  check and its output in `environment.md` before the first change. If the
  experiment can run only against production, the spike stops as blocked
  with that reason and never runs.
- **Resources the experiment will create:** approving this plan is the
  permission to create them.

  | Resource | Kind | Tag | Delete with |
  |---|---|---|---|
  | <name> | <container, database, branch, cloud resource…> | `spike:<slug>` <and any team tags> | `<command>` |

- **Ledger:** `resources.jsonl` in this folder. Append one line the moment a
  resource exists, and one when it is gone:

  ```json
  {"event": "created", "name": "<unique name>", "tag": "spike:<slug>", "delete": "<command>", "at": "<ISO-8601 UTC>"}
  {"event": "torn-down", "name": "<same name>", "proof": "<command> -> <observed result>", "at": "<ISO-8601 UTC>"}
  ```

  Commit the ledger with each line, so the goal branch keeps it even if the
  worktree is lost. Every resource carries the tag, so it can be found even if
  the ledger is lost too. A resource not in the plan's table is still recorded
  before use.
- **Teardown:** the last evidence criterion deletes every ledger entry, with
  proof, so the gate will not end the spike while anything still runs.

## Harness placement

*Decide this in the plan. The default follows the brief's rule that the
winner's measured number becomes the regression guard.*

- **Default:** the benchmark harness lives in the repository's own test tree on
  the spike branch, so the mandatory quality gate covers it; on adopt it ships
  with the promotion as the regression guard.
- **Alternative:** keep the harness out of the product repository and guard
  the promotion with a lighter check. Chosen when <reason>.

## Promotion acceptance criteria, in advance

*What the promotion goal's criteria will be if the verdict is adopt. The
winning option's measured number becomes the regression guard.*

- <the winning change in the product code, at production quality, naming the
  path that holds it>
- <the regression guard: in one run of the benchmark command against the
  harness path, the change beats the baseline by at least the smallest effect
  that counts>. *A same-run comparison travels to CI and other hardware; an
  absolute number does not.*
- <Any migration, documentation, or rollout criterion>
- The repository's real lint, type-check, and test commands pass.

## Findings

The loop writes `findings.md` in this folder in this shape:

```markdown
---
verdict: adopt | reject | inconclusive
winner: O<n> | none
baseline-commit: <the SHA the baseline is pinned to>
spike-commit: <SHA on goal/<slug> that holds the winner, or the final commit>
---

# Findings — <question>

| Option | Metric (median of runs) | Change vs baseline | Clears the smallest effect? |
|---|---|---|---|

## Verdict
<the verdict against the verdict rule, with the numbers>

## Explanation
<why the numbers came out this way>

## The winning solution
<outline of the change, on adopt; "none" otherwise>
```

## Journal

Write the entry with `eque2-code-journal` (write mode), workstream
`<journal-workstream>` — not the user-level `journal` skill. Win or lose:

- **Verdict mapping:** adopt → `success`; reject → `failed`; inconclusive →
  `inconclusive`. Name the spike verdict word in **Outcome** as well.
- **Goal** — the question and the hypothesis. **Approach** — the options, the
  metric, the noise floor, the verdict rule, the environment. **Outcome** —
  the numbers per option against the baseline. **Next time** — what a later
  spike should try or avoid. **Artefacts** — `findings.md` and the spike-branch
  commit.

If `eque2-code-journal` is not installed in this checkout, write the entry in
its storage layout: the entry file `_bmad-output/journals/<journal-workstream>/YYYY-MM-DD-<slug>.md`,
its line at the top of `JOURNAL.md`, and the reconciled `STATE.md`. Spike
brings the entry into the main checkout after the loop ends.

## Decisions for plan-goal

Each becomes a `[D<n>]` decision in `decisions.md`, with its criterion
phrased as evidence the decision was honoured — never as the answer. Write the
numbers (run count, smallest effect, thresholds, budgets) into each decision's
**Choice**, so the approval hash covers them.

- **The lane: light.** No `[CS]`/`[DS]` and no test state — the spike goal's
  criteria are the whole contract, and the loop runs the experiment directly.
  The heavy lane would append specification criteria after the spike-criteria
  check, and those could state the answer.
- <the option set>
- <the metric, the baseline run count, and the smallest effect that counts>
- <the verdict rule>
- <the target environment and its non-production proof>
- <the harness placement>
- <the budget per option>
- <the test design: baseline once, benchmark-only option runs, the closing
  drift check, the full suite once at the end>
- <the promotion acceptance criteria agreed in advance, so the approval hash
  covers them>

## Spike goal acceptance criteria

Write these criteria, in this order. Each proves that an answer exists, never
what the answer is; every one of them can be met when the verdict is reject or
inconclusive. A `[D<n>]` tag may lead the matching criterion here instead of
adding a duplicate. The first backticked span of each criterion is its evidence
file, so keep every other name unquoted, name options by id only, and keep
numbers with units out of the criteria — the checker flags a comparison
followed by one.

1. The target environment is named and proven non-production before the first
   change — `environment.md`
2. The baseline is measured <run count> times, its variance recorded, pinned to the
   commit SHA and fixture hash — `baseline.md`
3. One criterion per option: O<n> is measured against the baseline, or marked
   inconclusive when its budget ran out or the noise floor exceeds the smallest
   effect that counts — `results.md`
4. The verdict is written — adopt, reject, or inconclusive — with the numbers,
   against the approved verdict rule — `findings.md`
5. The findings are written: explanation, outline of the winning solution on
   adopt, and the spike-branch commit that holds it — `findings.md`
6. A journal entry is written in the eque2-code-journal layout, win or lose —
   `_bmad-output/journals/<journal-workstream>/JOURNAL.md`
7. Every resource in the ledger is torn down, with proof — `resources.jsonl`
8. The repository's real lint, type-check, and test commands pass — the
   mandatory quality gate plan-goal adds
