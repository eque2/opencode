# Plan — `/task` harness feedback

- Input: [`./task-questions.md`](./task-questions.md) (13 questions; question 13 added 2026-10-14)
- Technical decisions: [`./decisions.md`](./decisions.md) (27 decisions)
- Acceptance criteria: [`./ACs.md`](./ACs.md) (29 criteria, 3 critical)

## Stage sequence

| Stage | Workflow | Serves |
|---|---|---|
| 2 | `bmad-architecture` — the run machine's shape, the actor topology, the fact list, the status projection contract, the task-ui view machine | D1–D9, D16 |
| 2 | `bmad-ux` — one `EXPERIENCE.md` for the task-ui: header, failure reasons, the blocked card, scenario rows, task durations, the animated diamond | D16–D21, D23 |
| 2 | `eque2-code-create-spec` `[CS]` | D1–D24 |
| 3 | `eque2-code-develop-spec` `[DS]`, phase 1 | D1–D5 |
| 3 | none — checkpoint `git merge --no-ff` into `dev` in the main checkout; no push | D26 (AC 7) |
| 3 | `eque2-code-develop-spec` `[DS]`, phases 2–4 | D6–D24 |
| 3 | none — the live check in `tmux`, with the cap in D25 | D25 |
| 3 | none — final `git merge --no-ff` into `dev` in the main checkout; no push | D26 (AC 28) |
| — | none — a scope boundary, nothing to run | D27 |

`[CS]` orders its tasks by phase, so `[DS]` builds them in this order:

1. **Phase 1 — one run machine (D1–D5), about 1 day.** It fixes the observed stuck run. The phase ends with the
   graph proof and the quality gate green, then the checkpoint merge.
2. **Phase 2 — live supervision as actors (D6–D9), about 2–3 days.** The runner, the session watch, the hooks and
   the status projection. The audit test (D9) lands first in this phase, with an allowlist that shrinks to its
   final entries as each part moves.
3. **Phase 3 — validation and fault folders (D10–D15), about half a day.**
4. **Phase 4 — task UI (D16–D24), about 1–2 days.** It reads the status contract from phase 2.
5. **The live check (D25), about 1 hour**, then the final merge.

Total: about 5–7 days of agent time.

## Lane

Heavy. It changes the system's shape (one plan-generated machine and a supervision actor tree replace four
machines and the polled runner), changes the `status.json` contract (tags, blocked causes, times, titles), changes
the `VERIFY.md` schema (`ensures` required), adds a dependency to `packages/tui`, touches many existing files and
adds new ones, and changes what the user sees in the TUI.

## Worktree

- Path: `{project-root}/.claude/worktrees/task-harness-feedback`
- Branch: `goal/task-harness-feedback`
- Base: the local `dev` HEAD (`03bc3afb82` at planning time), so it carries the merged harness and `task-demo.sh`.
- `git config eque2.worktreeRoot` is not set, so the default applies. Stage 2 creates the worktree and runs
  `bun install` in it.

## Declined workflows

- `bmad-prd` — one feature area with no epics; `decisions.md` and `ACs.md` carry the requirement.
- `bmad-create-epics-and-stories` — no PRD to slice; `[CS]` writes the task list, ordered by phase.
- `eque2-code-e2e-test` — it drives a browser with Playwright; this is a terminal UI. The live `tmux` check (D25)
  and the opentui test renderer in `packages/tui/test/task-ui/` prove the journey instead.
- `bmad-testarch-atdd` — `ACs.md` already fixes the behaviour; `[CS]` writes its scenarios from it.
- `eque2-code-create-pr` — this fork merges goals into `dev` locally (D26); no pull request.

## Skill availability

All named skills installed: `bmad-architecture`, `bmad-ux`, `eque2-code-create-spec`, `eque2-code-develop-spec`
(disk check on 2026-10-14). The declined skills are also installed.
