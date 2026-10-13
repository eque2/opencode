# task-ui

Seven candidate designs for showing a running `/task` (the O2 task harness) in the opencode TUI. They are one external
TUI plugin that nothing in opencode imports. The design spec and captures of every design are in
`_bmad-output/planning-artifacts/ux-designs/ux-opencode-2026-10-13/`.

| # | Design | Where it shows | Expanded |
|---|---|---|---|
| 1 | Ledger | Task tree in the sidebar | Details under the tree |
| 2 | Dock | Status line at the bottom of the screen | Details above the line |
| 3 | Board | Shortcut bar only | Full-screen board of task stages |
| 4 | Matrix | Shortcut bar only | Full-screen grid of proofs and scenarios |
| 5 | Gantt | Shortcut bar only | Full-screen timeline of the run |
| 6 | HUD | Floating panel in the top-right corner | Details under the panel |
| 7 | Ticker | Line in the shortcut bar, and a notice on each change | Dialog with the task list and details |

## Run a demo

```bash
bash packages/tui/src/task-ui/launch.sh --design 1
```

1. The script deletes and recreates `~/release-notes-try` (the target repository) and `~/oc-task` (a separate
   opencode database).
2. It starts a local opencode server with the O2 harness and trusts T9.
3. It opens the TUI on its home screen. Start the run by typing:
   `/task task-formats/blend/release-notes.spec`

The run uses a live model: about $1–3, and 30 minutes at most. Closing the TUI stops the run.

## Keys

The shortcut bar at the bottom right of the input box shows the keys for the current design.

| Key | What it does |
|---|---|
| `ctrl+x o` | Expand or collapse the design (every design) |
| `/task-design` | Choose a design from a list |
| `ctrl+x v` | Switch to the next design |
| `ctrl+x j` / `ctrl+x k` | Select the next or previous task, at any time |
| Tab / Shift+Tab | While the run is live: select the next or previous task (in the watch view, the next or previous task in work). Otherwise Tab switches agents; `ctrl+x a` lists them at any time |
| `ctrl+x w` | Start or stop the watch view (every design) |
| `esc` twice | In the watch view, while the run is live: stop the run |
| `esc` | Collapse a full-screen view or the Ticker dialog |

## Watch view

`ctrl+x w` shows the selected task's running work in the session area, in opencode's own session rendering, inside
a double frame in the accent colour. A band above the frame says what is watched and that the view is watch only;
what you type still goes to the main session.

- The run is **live** when the session on screen owns the run's harness sessions (`T1.4 builder`), the run has not
  ended, and the status file, a harness session or a proof log changed in the last five minutes. Tab, `esc` twice and
  the watch view act only on a live run in its own session; after a server stop, nothing moves and they step aside.
- A building task shows its latest builder session; a verifying task its latest verifier. Until the session exists
  and has loaded, the band says `waiting for …` over your own transcript, unframed.
- A proving task shows a PROOF panel over its last builder, with the tail of `.opencode/task/proofs/<task>.log`. The
  harness empties that file at the start of each proving pass, then appends each command's `$` line, its output as
  it arrives, and `exit <code>` or `timed out`. With no task in work, a log written in the last ten seconds shows
  instead: a parent's proofs (`watching T1 proofs`) or the scenarios' (`watching scenarios proofs`).
- Tab moves to the next task in work. When no task is in work, the band names what the run waits on, or how it ended.
- `esc` twice (within 5 seconds) aborts the root session, which cancels the run; the notice says so only once the
  server took the stop. opencode's own `esc` keys (autocomplete, shell mode, the interrupt, a dialog, a permission or
  question) win over it. Type the same `/task` to start the run again.
- In Board, Matrix and Gantt, turning the view on collapses the full-screen view: the watch view shows only in the
  session screen.

The frame and the band come from a generic core capability: the session route's `watch` parameter and the
`session_watch` slot (`packages/opencode/specs/tui-plugins.md`). Without this plugin, nothing sets `watch`.

## Keep one, remove the rest

- **Keep one:** keep `store.ts`, `peek.tsx`, `ui.tsx`, `watch.tsx`, `index.tsx` and the chosen file under `designs/`.
  Remove the other designs' `register…` calls from `index.tsx`. Keep `designs/screen.tsx` only for Board, Matrix or
  Gantt; without it, `watch.tsx` no longer needs its `SCREENS`.
- **Remove them all:** delete this folder and its tests, `packages/tui/test/task-ui/`. No other file refers to
  either.
