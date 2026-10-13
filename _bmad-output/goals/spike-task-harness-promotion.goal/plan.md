# Plan — promote the spike-task-harness winner (O2) to production

- Input: [`./promotion-brief.md`](./promotion-brief.md)
- Technical decisions: [`./decisions.md`](./decisions.md) (9 decisions)
- Acceptance criteria: [`./ACs.md`](./ACs.md) (13 criteria)

## Stage sequence

| Stage | Workflow | Serves |
|---|---|---|
| 2 (before `prepare-goal`) | none — commit the main checkout's eque2-code 0.67.1 upgrade on `dev`, on the developer's word | D4 |
| 3 | `bmad-build` | D1, D2, D3, D5, D6, D9 |
| 3 | `eque2-code-plan-goal` (revise the paused `task-harness` goal; no approval written) | D7 |
| 3 | none — `git merge --no-ff` in the main checkout, no push | D8 |

## Lane

Heavy. It adds many files, adds a runtime dependency (`@jambudipa/xstate-effect`), changes a public interface (`/task` becomes a code-backed command; the TUI plugin API gains the `session_watch` slot), and changes what the user sees (the task-ui designs and the watch view).

## Worktree

Required: `{project-root}/.claude/worktrees/spike-task-harness-promotion`, branch `goal/spike-task-harness-promotion`, from the main checkout's `HEAD` on `dev`. Stage 2 creates it. The spike branch `goal/spike-task-harness` stays as the record, and is not deleted after the merge.

## Declined workflows

- `bmad-prd` — one feature, already decided and measured by the spike; the brief and `decisions.md` carry the requirement.
- `bmad-architecture` — the system shape is the spike's measured winner; D1–D9 record it.
- `bmad-create-epics-and-stories` — no PRD and no epics; `bmad-build`'s spec holds the task list.
- `bmad-ux` — the task-ui and watch-view UX spines are final and built; they stay on the spike branch as the record.
- `eque2-code-create-spec` `[CS]` and `eque2-code-develop-spec` `[DS]` — the spike produced the design, the tests and the conformance guard; the work is transfer, removal and hardening of tested code, which `bmad-build` does against these criteria with its own spec and review triage log. The develop-spec verifier's live Playwright run does not fit a terminal UI and server change.
- `eque2-code-create-pr` — the developer asked for a local merge, and the developer's rule is never to push.
- `eque2-code-e2e-test` — the conformance suite already drives the real server end to end with a scripted model.

## Skill availability

All named skills installed: `bmad-build`, `eque2-code-plan-goal` (checked on disk in the main checkout, 2026-10-13).
