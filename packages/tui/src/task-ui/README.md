# task-ui

The built-in TUI plugin `internal:task-ui` shows a running `/task` in the opencode TUI: the harness's task tree, each
task's state and attempts, the obligations and scenarios, and what the builder and verifier sessions are doing. It is
read-only; nothing in it writes to the harness. Every surface carries the mark `◆ In the Flow`, so none of it reads as an
ordinary subagent task.

## Where it reads the run

The `/task` harness writes `<directory>/.opencode/task/status.json` as the run moves
(`packages/opencode/src/task/core/status.ts`). The plugin's `taskView` machine (`machine.ts`) reads that file, its
age, and the proof logs in `.opencode/task/proofs/` once a second. A file that is half written or of another shape
keeps the last good status on screen; with no status file, the plugin shows nothing.

The run's liveness comes from the file alone:

- **ended** when the run carries the `ended` tag;
- **live** when the harness's heartbeat `run.aliveAt` is at most 15 s old;
- **still** otherwise: the job stopped writing (it was killed, or the machine slept).

Tab and `esc` twice act only on a live run, in the session that owns the run's harness sessions (titled like
`T1.4 builder`). The watch view needs only that session: it also shows a still or ended run.

## What it shows

- **States by their tags.** Every grouping reads a unit's tags from the status file (`waiting`, `active`, `ended`,
  `stopped`, `blocked`, `dead`): the Board columns, the STOPPED groups and the counts. The display table `DISPLAY`
  (`store.ts`) gives a state name its glyph, its tone and its Gantt block, and an active phase its Board column
  (BUILDING, PROVING or VERIFYING); the tags choose whether a task is active, and every other column.
- **Reasons.** Each expanded view has a shared region (`shared.tsx`): the run warning when the spec stopped
  validating, the outside wait lines (`waiting on T9 (outside) — run /task trust T9`), the STOPPED list with each
  stopped task's reason, and the SCENARIOS list. The Peek's heading says why a task stopped or what it waits on.
- **Scenarios.** The SCENARIOS list names each scenario with its state and reason; its heading counts the trusted
  ones. A scenario parked on an outside task shows as waiting.
- **Durations.** `45s`, `3m 12s`, `1h 4m`. A task in work counts while the run is live, stops at the last heartbeat
  while it is still, and is fixed once the task ended. The HUD's elapsed time and the Gantt use the run's span.
- **Run usage.** The summed tokens (input, output and reasoning; no cache) and cost of the root session's child
  sessions (`usage.ts`), in the prompt footer, the sidebar Context panel, the HUD, the full-screen header, the Dock
  and the Ticker dialog. It stays hidden until a harness session reports tokens.
- **The mark.** The `◆` of `◆ In the Flow` is a spinner (`· ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩`, 120 ms a frame) at every site while
  the run is live and the `animations_enabled` setting is on; otherwise it is a static `◆`.

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

The shortcut bar at the bottom right of the input box names the design and shows the run warning, an outside wait,
and the keys that apply now; designs 3, 4, 5 and 7 add the trusted and stopped counts. It no longer shows `/task-design`, which
stays in the command list. `ctrl+x` is the default leader key; the bar shows the configured one.

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
| `index.tsx` | The plugin entry: the `taskView` actor, the commands and keys, and each design's registration |
| `machine.ts` | The `taskView` machine: the design, the selection, the expansion, the watch, the stop key, the liveness, and every periodic read as a delayed transition |
| `actor.ts` | `fromActor`, the one bridge from the actor's snapshot to a Solid signal |
| `view.ts` | The view the designs read: accessors over the actor's snapshot and the events that change it |
| `store.ts` | The status schema, the task tree, the tag classes, the display table and the durations |
| `shared.tsx` | The shared region: the run warning, the outside waits, STOPPED and SCENARIOS |
| `usage.ts` | The run usage of a `/task` root session |
| `ui.tsx` | The shortcut bar, the mark, the Tab layer and the parts the designs share |
| `peek.tsx` | The task details: builder, proofs and verifier |
| `watch.tsx` | The watch view, its band, the PROOF panel and `esc` twice |
| `designs/` | One file per design; `screen.tsx` is the full-screen route of Board, Matrix and Gantt |
