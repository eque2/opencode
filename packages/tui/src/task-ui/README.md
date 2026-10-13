# task-ui

Seven candidate designs for showing a running `/task` (the O2 task harness) in the opencode TUI. It is one external
TUI plugin that nothing in opencode imports. The design spec and captures of every design are in
`_bmad-output/planning-artifacts/ux-designs/ux-opencode-2026-10-13/`.

| # | Design | Where |
|---|---|---|
| 1 | Ledger | Task tree at the top of the session sidebar |
| 2 | Dock | One-line strip at the bottom of every screen |
| 3 | Board | Full-screen kanban (`ctrl+x p`) |
| 4 | Matrix | Full-screen grid of obligations and scenarios (`ctrl+x p`) |
| 5 | Gantt | Full-screen timeline from the status history (`ctrl+x p`) |
| 6 | HUD | Floating panel in the top-right corner |
| 7 | Ticker | Line beside the prompt, toasts, and a peek dialog |

## Run one

```bash
bash packages/tui/src/task-ui/launch.sh --design 3
```

The script works in this order:

1. It deletes and recreates `~/release-notes-try` (the target repository) and `~/oc-task` (a separate opencode
   database).
2. It starts a local opencode server with the O2 harness and trusts T9.
3. It starts `/task task-formats/blend/release-notes.spec`, then attaches the TUI to the run's session.

The run uses a live model: about $1–3, and 30 minutes at most. Closing the TUI stops the server and the run. In the
TUI, use these keys:

- `ctrl+x j` and `ctrl+x k` select a task.
- `ctrl+x o` opens the peek.
- `ctrl+x v` switches to the next design.
- `ctrl+x p` opens the full-screen view.

## Keep one, remove the rest

- **Keep one:** keep `store.ts`, `peek.tsx`, `ui.tsx`, `index.tsx` and the chosen file under `designs/`. Remove the
  other designs' `register…` calls from `index.tsx`. Keep `designs/screen.tsx` only for Board, Matrix or Gantt.
- **Remove them all:** delete this folder and its tests, `packages/tui/test/task-ui/`. No other file refers to
  either.
