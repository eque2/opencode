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
| `ctrl+x j` / `ctrl+x k` | Select the next or previous task |
| `esc` | Collapse a full-screen view or the Ticker dialog |

## Keep one, remove the rest

- **Keep one:** keep `store.ts`, `peek.tsx`, `ui.tsx`, `index.tsx` and the chosen file under `designs/`. Remove the
  other designs' `register…` calls from `index.tsx`. Keep `designs/screen.tsx` only for Board, Matrix or Gantt.
- **Remove them all:** delete this folder and its tests, `packages/tui/test/task-ui/`. No other file refers to
  either.
