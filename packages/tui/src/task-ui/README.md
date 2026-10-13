# task-ui

The built-in TUI plugin `internal:task-ui` shows a running `/task` in the opencode TUI: the harness's task tree, each
task's state and attempts, the obligations and scenarios, and what the builder and verifier sessions are doing. It is
read-only; nothing in it writes to the harness. Every surface carries the mark `◆ In the Flow`, so none of it reads as an
ordinary subagent task.

## Where it reads the run

The `/task` harness writes `<directory>/.opencode/task/status.json` as the run moves
(`packages/opencode/src/task/core/status.ts`). The plugin reads that file, its age, and the proof logs in
`.opencode/task/proofs/` once a second. A file that is absent, half written or of another shape keeps the last good
status on screen; with no status file, the plugin shows nothing.

The run is **live** while it has not ended, the session on screen owns the run's harness sessions (titled like
`T1.4 builder`), and the status file, a harness session or a proof log changed in the last five minutes. Tab, `esc`
twice and the watch view act only on a live run, in its own session.

## Designs

The plugin starts on the design chosen last, and on design 1 the first time. `/task-design` opens a list of the seven
designs; `ctrl+x v` switches to the next one.
Each switch shows a notice that names the design and where it shows.

| # | Design | Where it shows | Expanded (`ctrl+x o`) |
|---|---|---|---|
| 1 | Ledger | Task tree at the top of the sidebar | Details under the tree |
| 2 | Dock | Status line at the bottom of the screen | Details above the line |
| 3 | Board | Shortcut bar only | Full-screen board of task stages |
| 4 | Matrix | Shortcut bar only | Full-screen grid of proofs and scenarios |
| 5 | Gantt | Shortcut bar only | Full-screen timeline of the run |
| 6 | HUD | Floating panel in the top-right corner | Details under the panel |
| 7 | Ticker | Line in the shortcut bar, a notice on each task change, a notification when the run ends | Dialog with the task list and details |

In Ledger and Dock, a click on a task selects it, and a second click expands or collapses its details. In HUD, a click
on the panel expands or collapses it.

## Keys

The shortcut bar at the bottom right of the input box names the design and shows the keys that apply now. `ctrl+x` is
the default leader key; the bar shows the configured one.

| Key | What it does |
|---|---|
| `/task-design` | Choose a design from a list |
| `ctrl+x v` | Switch to the next design |
| `ctrl+x o` | Expand or collapse the design |
| `ctrl+x j` / `ctrl+x k` | Select the next or previous task, at any time |
| Tab / Shift+Tab | While the run is live: select the next or previous task. In the watch view: the next or previous task in work. Otherwise Tab switches agents as usual |
| `ctrl+x w` | Start or stop the watch view |
| `esc` twice | In the watch view, while the run is live: stop the run |

In the full-screen views of Board, Matrix and Gantt, `j`/`down` and `k`/`up` select a task, `v` switches to the next
design, and `esc` or `q` returns to the session. In the Ticker dialog, `j`/`down` and `k`/`up` select a task and `esc`
closes it.

Tab steps aside on the home screen, while the prompt's autocomplete is open, and while a dialog is open; `ctrl+x a`
still lists the agents.

## Watch view

`ctrl+x w` shows the selected task's running work in the session area, in opencode's own session rendering, inside a
double frame in the accent colour. A band above the frame says what is watched and that the view is watch only: what
you type still goes to the main session. The watch view works with every design. In Board, Matrix, Gantt and Ticker,
turning it on collapses the expanded view, because the watch view shows in the session screen.

- A building task shows its latest builder session; a verifying task shows its latest verifier (a parent task's
  reviewer). Until the session exists and has loaded, the band says `waiting for …` over the root session's own
  transcript.
- A proving task shows a PROOF panel over its last builder, with the tail of `.opencode/task/proofs/<task>.log`. The
  harness empties that file at the start of each proving pass, then appends each command's `$` line, its output as it
  arrives, and `exit <code>` or `timed out`. With no task in work, a log written in the last ten seconds shows
  instead: a parent's proofs (`watching T1 proofs`) or the scenarios' (`watching scenarios proofs`).
- Watching from a task that is not in work starts on the next task in work. When no task is in work, the band names
  what the run waits on, or how it ended.
- `esc` twice within five seconds aborts the root session, which stops the run. The first press shows a warning; the
  notice after the second says the run stopped only once the server took the stop, and names the `/task` that starts
  it again. opencode's own `esc` keys (autocomplete, shell mode, the interrupt, a dialog, a permission or a question)
  win over it.

The frame and the band come from a generic core capability: the session route's `watch` parameter and the
`session_watch` slot (`packages/opencode/specs/tui-plugins.md`). This plugin is what sets `watch`.

## Files

| File | What it holds |
|---|---|
| `index.tsx` | The plugin entry: the status poll, the live check, the commands and keys |
| `store.ts` | The status schema, the task tree, the selection, the expanded state and the design number |
| `ui.tsx` | The shortcut bar, the Tab layer and the parts the designs share |
| `peek.tsx` | The task details: builder, proofs and verifier |
| `watch.tsx` | The watch view, its band, the PROOF panel and `esc` twice |
| `designs/` | One file per design; `screen.tsx` is the full-screen route of Board, Matrix and Gantt |
