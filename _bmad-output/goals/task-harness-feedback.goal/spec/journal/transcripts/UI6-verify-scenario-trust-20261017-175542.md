# UI6 semantic verification transcript

## Inputs and code read
- Read the UI6 dispatch prompt, guardrails, semantic-verifier skill, previous UI6 journal, `spec.md`, UI6 in `scenarios.gherkin`, tasks T4.8/T4.10, their journals, and D16 in `defects.md`.
- Read the committed `packages/opencode/test/task/verify-spec-UI6.spec.ts` and its `lib/command.ts` helper. Inspected `TaskCommand.plan`, `leftOut`, `header`, `headerParts`, `run`; `SessionPrompt.command`, `taskOps.prompt`, `createUserMessage`, and the no-reply path; `Session.updatePart`, `Session.messages`, and the session projector; the TUI route and `task-header.tsx`; the status projection.
- Read the release-notes `SPEC.md`, T1.2 `TASK.md`, and all thirteen `acceptance/S*.md` dependency lines. The spec H1 and task H1 match the test's fixed titles. S3 alone needs only T1.2. Each other scenario needs a task outside the T1.2 subtree.
- `git show --stat --oneline e39c031e31` confirms the committed UI6 test revision. The existing unrelated worktree changes were left alone.

## Gherkin step → assertion
1. Given the release-notes title: `TITLE` at test line 95 matches the fixture H1. `seed(SPEC)` loads a committed copy.
2. When `/task` starts whole and subtree runs: lines 148–156 and 193–200 drive `TaskCommand.run` and assert one job start each. Lines 245–276 call real `SessionPrompt.command` for the subtree and read the root session's stored first message.
3. First message and metadata: lines 157–169 assert the complete whole-spec text part and structured metadata. Lines 258–276 assert stored subtree text and metadata after the real session projector, closing D16's storage gap.
4. Muted lead and bold title from metadata: lines 171–188 assert frame text, span tones and weight. Different text with the same metadata yields the header; the original text without metadata stays plain. The route uses `splitHeader` and `MessageBody`.
5. Subtree wording: lines 209–235 assert its exact text, task and spec metadata, frame, lead tones, and bold task and spec titles.
6. Empty-title fallback and status: lines 281–335 assert written status title and subtree task, task-ui parsing, Ledger title, fallback header metadata/text/render and status title. An empty H1 cannot load, so the test supplies a plan with an empty title to exercise this boundary.
7. Left-out line: lines 99–100 pin `S1, S2, S4–S13`; lines 204–235 assert exact IDs, text, metadata, and muted render. The fixed expectation is independent of `TaskCommand.leftOut`. The whole run has no left-out line.
8. Older scrollback header: lines 338–389 start a later run after releasing the lease, update the status to the later title, and render both messages from their own metadata. The earlier message keeps its title.

## Commands and result
- `state.mjs <spec> query scenario/UI6`: before verdict, state `completed`, trustLevel `verified`.
- `git show --stat --oneline e39c031e31`: one committed UI6 test changed.
- `bun test --timeout=30000 ./test/task/verify-spec-UI6.spec.ts` from `packages/opencode`: 5 pass, 0 fail, 69 assertions, 16.86 s.
- Exactly one `state.mjs <spec> verdict UI6 trusted --reason ...`: succeeded and returned trustLevel `trusted`.
- `state.mjs <spec> query scenario/UI6`: state `completed`, trustLevel `trusted`.

## Outcome
D16 is closed: both the fixture-derived omitted IDs and the real stored header metadata have independent assertions. No UI6 Gherkin gap remains. No evidence or key was read. No source, test, or protected state file was hand-edited; no commit was made.
