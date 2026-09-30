# `[ST]` — goal status, derived, never stored

**Configuration:** Use `{communication_language}` for the report.

There is no status field, no `status.json`, and no registry. Status is
computed from the artifacts that exist, so it cannot disagree with
reality. Report it fail-closed: an unreadable artifact is reported as
exactly that, never guessed around.

## Enumeration

Scan `_bmad-output/goals/` in the **current checkout** only. Every goal
appears there as either a live `<slug>.goal/` folder or a
`<slug>.moved` stub. Follow each stub's `moved-to:` path to read the
worktree's canonical copy. A direct inline goal stays in its current
checkout, so report status from that checkout. **Never walk `git
worktree list` to find goals** — the local folder and stub set IS the
index.

## States — first match wins

Resolve each goal top to bottom; the first state that matches is the
answer.

| State | Derived from |
|---|---|
| `stale` | A `.moved` stub whose `moved-to` path does not exist |
| `done` | Every acceptance criterion is ticked **and** evidenced |
| `pursuing` | Stage-3 loop state is bound for this goal |
| `prepared (direct inline)` | `DIRECT.md`, `goal.md`, and valid `ACs.md` exist with no bound loop |
| `prepared` | A `.moved` stub exists (no-worktree case: `goal.md` exists) |
| `approved` | The stage-1 approval marker `.approved` exists |
| `planned` | `plan.md` exists and nothing above matched |

Mechanics, using the gate's own tooling (never re-implement the
parsing):

- **done** — `bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh <folder>/ACs.md`
  (strict mode) exits 0 with `unchecked=0`, `blocked=0`, and
  `total` > 0. Blocked criteria are honest non-completion, never done.
- **pursuing** — `bash {skills-root}/eque2-code-goal-gate/cancel.sh status`
  run in the goal's checkout (the worktree, for a moved goal) reports
  an active loop bound to this folder.
- **AC tally** — once `ACs.md` exists, report `met/total` from the
  checker's `checked=`/`total=` counts (`--authoring` mode, so a
  freshly prepared contract tallies instead of erroring).

## Annotations from the approval gate

- `.approved` with `approved-by: OVERRIDE` → report
  `approved (OVERRIDE — plan not reviewed)`.
- `.approved` whose `plan-hash`, `decisions-hash`, or `acs-hash` no
  longer matches `git hash-object` of its file → the approval is void:
  report `planned (approval voided — <file> edited)`.
- A folder with neither `plan.md` nor any state above → report it
  malformed, naming what is missing. Unknown resolves to not-done,
  never to a healthy-looking state.

## The report

One line per goal: slug, state (with annotation), the worktree path
where one exists, and the AC tally once `ACs.md` exists — e.g.

```
vector-search   pursuing   ~/work/repo-vector-search   ACs 3/7
dark-mode       approved (OVERRIDE — plan not reviewed)
onboarding-fix  stale      (worktree gone: /tmp/wt-onboarding)
```

Follow with one sentence naming the obvious next action for anything
actionable — a stale goal to restore or abandon, an approved goal ready
for `[PG]`, a prepared goal waiting for a fresh context to run `[PU]`.
When complete, the report lists every discovered goal with one derived
state and one next action or an explicit reason it needs none.
