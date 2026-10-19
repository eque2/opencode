# AC 27 live check — 2026-10-19

Each run: a new empty folder under `.task-conformance/live/<name>` in the worktree (gitignored), seeded and opened by
`packages/opencode/script/task-demo.sh` in its own tmux session (220 × 56), at HEAD 09e0ef8454. Panes were captured
with `tmux capture-pane -e` (`*.ansi`, colours and attributes kept); each `*.txt` is the same capture with the escape
codes removed.

Model: `github-copilot/gpt-5.6-terra`, set for the demo TUI through `OPENCODE_CONFIG_CONTENT`. The TUI's most recent
model was `openai/gpt-6.1-sol`, and `anthropic/claude-opus-5-5-fast` averaged about $13 per session in the local store,
which the $5 cap does not allow. GPT-5.6 Terra is the model of the owner's earlier task demo (`~/task-demo`).

Spend: the summed `cost` of the sessions whose `directory` starts with the run folder
(`~/.local/share/opencode/opencode-local.db`, table `session`). `live-check.sh spend` matches the folder exactly and
misses the task worktree sessions under `.opencode/task/worktrees/`, so the query used a prefix match.

| Run | Folder | Outcome | Sessions | Cost |
| --- | --- | --- | --- | --- |
| 1 | lc1-scenarios | `/task` was not dispatched (defect D22): the TUI sent the line to the model as a prompt; interrupted after 2 tool calls | 1 | $0.1327 |
| 2 | lc2-scenarios | the scenarios folder: run done, T1 and T1.1 trusted, S1 trusted, 1m 50s | 5 | $0.2313 |
| 3 | lc3-cascade | the cascade folder: run budget exhausted, T1.1 budget exhausted (BUILD-1 exit 1, 1 attempt), T1 and T1.2 blocked by T1.1, T1.3 trusted, 1m 31s | 4 | $0.2304 |
| | | total: 3 of 4 runs | 10 | $0.5944 |

Runs 2 and 3 ran with both global MCP servers disabled in the same `OPENCODE_CONFIG_CONTENT`
(`"mcp": {"atlassian": {"enabled": false}, "spicyapi": {"enabled": false}}`), the workaround for D22.

## What the captures show

- Bold spec title: `lc2-scenarios-summary.ansi` and `lc3-cascade-summary.ansi` — the run header "Implementing spec"
  followed by `ESC[1m` and the spec title.
- Scenario row: `lc2-scenarios-expanded.txt` — the expanded Board's "SCENARIOS 1 · 1/1 trusted" and
  "✓ S1 trusted · A release title become…"; `status.json` has S1 `trusted`.
- Task durations: the Board cards ("attempt 1 · 51s", "attempt 1 · 1m 24s") and the summary's Time column.
- Non-zero cost: "$0.23 spent in the run" (sidebar), "run 57.7K tokens · $0.23" (prompt footer), and the expanded
  header "58.5K tokens · $0.23".
- Blocked card with its cause: `lc3-cascade-expanded.txt` — "⊖ T1.2 blocked by T1.1: budget exhausted" and
  "⊖ T1 blocked by T1.1: budget exhausted" in the STOPPED column; `status.json` gives `blockedBy` T1.1
  `budget_exhausted` for both, and `run.reason` "T1.1 budget exhausted / T1 blocked by T1.1 / T1.2 blocked by T1.1".
- Closing summary: both `*-summary.txt` — "Spec Slugs for release titles — done" with "Tasks 2/2 trusted · Scenarios
  1/1 trusted · 1m 50s · 57.7K tokens · $0.23"; "Spec Number helpers that fail on purpose — budget exhausted" with the
  Stopped list and the Tasks table.
