# UI3 semantic verification (verify-scenario-trust, 2026-10-19, HEAD 162ce61dee)

## Read

- Dispatch prompt `journal/prompts/scenario-UI3-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`; `journal/scenario/UI3.md` (earlier verify and trust entries).
- `scenarios.gherkin` lines 711-717 (UI3); `tasks.md` T4.1 and T4.3 Supports lines.
- `packages/opencode/test/task/verify-spec-UI3.spec.ts` (552 lines, clean at HEAD); `git show 162ce61dee`.
- Real code: `packages/tui/src/task-ui/machine.ts` (`livenessOf`, `stopKey`, `liveness`, `feed`), `view.ts`
  (`viewOf`), `actor.ts` (`fromActor`), `index.tsx` (plugin entry), `ui.tsx` (`barKeys`, `registerTab`),
  `watch.tsx` (`registerWatch`: watch toggle, esc layer, stop listeners); `packages/tui/test/task-ui/view.ts`
  (`viewFor`, `settle`).
- Query at start: state completed, trustLevel verified.

## Gherkin steps and covering assertions

1. Given a status file / When the run lacks the ended tag and its heartbeat is at most 15 s old — test 1:
   `viewFor` (real machine) at age 0 and 15 000 ms gives `live`, 15 001 and 60 000 ms give `still`; `LIVE_MS` is
   15 000. The machine's own feed over a real `status.json` with the real clock: the `liveness` region reads `live`.
2. Then the view is live, and Tab, esc twice and the watch keys act when the session owns its harness sessions —
   test 2 on the real plugin entry (opencode keymap, slot registry, SDK client over a recording fetch, heartbeat
   rewritten every 500 ms): Tab selects T1.3 with `agent.moves` 0; `ctrl+x w` navigates to `watch: ses_harness_0`;
   esc twice aborts `ses_root` exactly and toasts the restart line; Tab in the watch view selects the next task.
3. And an older or absent heartbeat makes it still, ended makes it ended, no file makes it absent — test 1: no
   heartbeat `still`; ended tag with a fresh heartbeat, done and refused `ended`; no status `absent`; disk feed: a
   minute old `still`, no heartbeat `still`, ended `ended`, file gone `absent`, and a 13 s heartbeat ages to
   `still`, then returns to `live`.
4. And the run keys leave a run alone when not live or not owned — test 3 (live but unowned; a minute old; no
   heartbeat; ended; no file): Tab reaches the agent key, the bar does not change, no navigation, no toast, no
   abort. Test 4: the stop key does not arm while still or ended; armed while live, it stops nothing after the view
   leaves live; while live, two presses give `["warn", "run"]`.

## Judgment on 162ce61dee

- The commit adds a local `until` (up to 100 settles) before three positive checks only. No assertion changed.
- Each wait ends on the expected change or after the bound; the exact `toEqual` follows. A missing or extra event
  still fails.
- The SimulatedClock moves only on `advance`. A real-time wait cannot fire the 5 s `stopWindow`, so the disarm in
  the "armed then still/ended" case comes from the `armed.always` liveness guard.
- Residual note (not new, not a reject reason): the negative checks keep one 15 ms settle, so a late wrong emit
  under heavy load can escape one run. An unloaded run catches it; machine unit tests kill the same mutations.

## Commands

- `state.mjs <spec> query scenario/UI3` → completed, verified.
- `git show 162ce61dee` → 9 insertions, 0 deletions, one file.
- `bun test --timeout=30000 ./test/task/verify-spec-UI3.spec.ts` (packages/opencode, load 13-15) → 4 pass,
  0 fail, 71 expect() calls, 15.86 s.
- `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .../state.mjs <spec> verdict UI3
  trusted --reason "..."` → exit 0, `"verdict":"trusted","trustLevel":"trusted"`.
- `state.mjs <spec> query scenario/UI3` → completed, trusted.

## Outcome

UI3 trusted. No source, test, or state file edited by hand; nothing committed.
