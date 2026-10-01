# Anti-patterns (refuse these)

Stage-2 failure modes. Each one has been paid for at least once.

## The gate and the plan

- **Preparing without the approval marker.** No `.approved`, no stage 2.
  Enthusiasm in the transcript, a question about the plan, or the fact
  that someone invoked this skill — none of these are approval. The
  marker file is the only route, and `--force` (user-typed, recorded as
  OVERRIDE) is the only override.
- **Preparing a plan that drifted after approval.** A mismatch on
  `plan-hash`, `decisions-hash`, or `acs-hash` is a refusal, not a
  warning. Building the edited set means building something the user
  never read.
- **Re-litigating the plan.** An approved `D<n>` is a contract.
  Disagreeing with it is a conversation for stage 1 and the user, not a
  silent substitution during preparation.
- **Weakening the approved ACs.** Removing, rewording, reordering, or
  ticking an approved criterion during preparation moves the finish
  line the user signed off. Stage 2 prepends the banner and appends
  criteria; anything else goes back to the user.
- **Silently substituting a NOT INSTALLED workflow.** The plan named the
  gap and the alternative; the user chooses, not the preparer.
- **Treating the charter as a rewritable starting point** during
  implementation — the charter is the contract.

## The folder and the worktree

- **Leaving two live copies of the goal folder.** The move into the
  worktree is a *move*, and the `.moved` stub is what keeps the main
  checkout honest. A copy left behind becomes the copy someone edits.
- **Skipping the stub** (worktree case), or **writing a stub** in the
  in-place fallback. The stub asserts "the canonical copy is
  elsewhere" — it must exist exactly when that is true.
- **Scattering artefacts.** Everything the run produces lands inside
  `X.goal/` — the SPEC included, pointed there directly, with the
  mirror as the recorded fallback for a pipeline that cannot be
  redirected. A spec written elsewhere and tidied up afterwards was
  still written in the wrong place.
- **Absolute internal references.** The folder moves as a unit only
  while every internal link is relative.
- **Switching the main tree's branch, or `git init`,** as a worktree
  substitute — that is the disturbance the worktree exists to avoid.
- **Creating the worktree over a dirty main checkout without asking** —
  or, worse, committing or discarding the user's uncommitted work to
  clear the way. The worktree branches from `HEAD`; that work is the
  user's to place, and the choice is theirs (§1a).
- **Putting the worktree outside the repository** — a `<repo>-<slug>`
  sibling, a `/tmp` path, anywhere but
  `{project-root}/.claude/worktrees/<slug>` (`.agents/worktrees/<slug>`
  on a Codex-only install). Only a user-named path or
  `git config eque2.worktreeRoot` moves it.

## The acceptance contract

- **Emitting ACs in the predecessor's YAML schema** (`type: script` /
  `check:` / `condition:`). The rule, stated as two halves that must be
  read together, because a later reader who "fixes" one breaks the
  other: the **loop mechanism** is the goal-gate **stop hook** — NOT a
  host agent's built-in goal command, and NOT the predecessor's
  runner — while the **criteria themselves** stay **natural-language
  markdown checkboxes in `X.goal/ACs.md`** — NOT machine-checkable
  script conditions. Reverting the mechanism does not license reverting
  the format, and the reverse is equally wrong. Each tick carries an
  indented `- evidence:` line; each unticked item carries
  `- explanation:`. Format rules: `references/acs-format.md`.
- **Restating the checklist inside `goal.md`.** The boxes live in
  `ACs.md` and the charter LINKS them (`./ACs.md`). Two copies drift,
  and a drifted acceptance contract means the charter says one thing
  and the gate enforces another.
- **Telling the reader to drive the charter with a host agent's
  built-in goal command.** The supported route is `pursue-goal <folder>`
  from a fresh context; a built-in goal command judges a conversation
  rather than an evidenced checklist, and leaves no record of what it
  judged.
- **A criterion phrased against a mock, stub, or stand-in.** The format
  rejects it (`references/acs-format.md` §3.3) — the surrogate failure,
  made unwriteable.
- **Omitting the mandatory quality-gate criterion** (the codebase's
  real lint + type-check + tests), deferring any of it to "later", or
  asserting only "tests pass" while ignoring lint/type-check.
- **A YOLO directive that fans out WITHOUT the canary gate.** One bug ×
  25 VMs = $700.

## The run itself

- **Declaring a phase complete without verifying the artefact on
  disk.**
- **Emitting the SPEC as a downstream promise instead of producing
  it** (heavy lane). The plan bound `[CS]` to THIS stage; a charter that
  tells the owner to go create the spec is stage-1 behaviour wearing
  stage-2 clothes.
- **Fabricating ceremony the lane declined** — an empty `spec/` with a
  manifest claiming a pipeline, test state initialised for a light-lane
  goal. Honest absence (`MANIFEST.md`: "no spec pipeline") beats fake
  presence.
- **Calling the run done after Phase E without Phase R** (adversarial
  contract review), or **emitting the Phase R findings report and
  stopping there** — findings are applied in the same run; a report
  that lists problems and leaves them is a failed Phase R.
- **Invoking `pursue-goal` at the end of the run.** The hand-off names
  the folder; the folder starts itself for whoever opens it NEXT, in a
  fresh context. Starting it here inherits the very conversation the
  separation exists to shed.
- **Wedging on a missing optional dependency.** If the `journal` skill
  (or a review skill) is absent, degrade gracefully — plain markdown by
  hand in the same shape — never dead-end.
- **Assuming a Claude slash-command exists under another agent.** Every
  mechanism has a Codex / other-agent equivalent in
  `references/agent-mapping.md` — use it rather than hard-coding a
  slash-command into a charter a Codex run will read.
