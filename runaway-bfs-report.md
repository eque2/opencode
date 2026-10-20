# Runaway `bfs` / `find` processes — 2026-10-16

## Symptom

Health check at 14:58:

- Load average 140 on 20 cores (5m 125.7, 15m 111.9)
- Free RAM 1.9 GB of 64 GB (3%)
- Swap 1.9 GB of 3.0 GB (62%)
- Six `bfs` processes at 20–380% CPU each, about 15 cores in total

## Who launched them

Each `bfs` is the `find` replacement that a Claude Code Bash tool call runs. The
model inside an eval sandbox wrote the `find /` command. Process chain:

```
launchd (pid 1)                      <- adopted the orphans
  └─ /bin/zsh -c source …/bmad-trigger-<id>/.home/.claude/shell-snapshots/snapshot-zsh-….sh …
       └─ /bin/zsh -c … eval 'find / … 2>/dev/null | head; …'
            └─ bfs -S dfs -regextype findutils-default / …
```

The original parent (the `claude` session inside each sandbox) no longer
exists. launchd adopted both zsh shells.

| bfs pid | zsh pids | Started | Sandbox | Command |
|---|---|---|---|---|
| 24585 | 24583, 24581 | 13:52:20 | `bmad-trigger-q009-r2-q7mt6pgm` | `find / -iname bedroom* -path *GenHQ*` |
| 24622 | 24621, 24620 | 13:52:20 | `bmad-trigger-q009-r1-0p72_cgl` | `find / -iname "bedroom*.jpg" 2>/dev/null \| head; ls docs` |
| 24714 | 24712, 24710 | 13:52:22 | `bmad-trigger-q009-r0-5n4fwuh9` | `find / -iname bedroom*.jpg -not -path */proc/*` |
| 28406 | 28405, 28399 | 13:53:25 | `bmad-trigger-q001-r2-43m0gbqh` | `find / -name scene3* -not -path /proc/*` |
| 35282 | 35277, 35269 | 13:55:17 | `bmad-trigger-q003-r2-53ndod3v` | `find / -name ad-script* -not -path */node_modules/*` |
| 35367 | 35366, 35358 | 13:55:20 | `bmad-trigger-q003-r1-o_1w65ba` | `find / -name ad-script.md -not -path */node_modules/*` |

Sandbox root: `/var/folders/x_/mlr9mcxd5gq0csqytn1dlr1c0000gn/T/`. All
`bmad-trigger-*` directories are already deleted.

## Notes

- The `bmad-trigger-*` sandbox directories were deleted while their shells were
  still running. The `find /` commands outlived their `claude` sessions.
- `find / … | head` did not stop early: `bfs` keeps scanning until it writes
  enough output to get SIGPIPE, and a search with no matches never writes.

## Action taken

The six `bfs` processes and their twelve zsh wrapper shells were killed at the
user's request after this report was written.
