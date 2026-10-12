# The orphan sweep — before any new work

**Configuration:** Use `{communication_language}` for the report.

A spike loop tears down its own resources in its last criterion. A loop that
was cancelled, blocked, or stalled runs no criterion, so its resources outlive
it, and a rejected spike's journal entry stays on a branch that is never
merged. The sweep closes both gaps before Spike starts anything new. Run it
once per conversation: on Spike's activation, or at the start of `[PS]`,
`[ES]`, or `[AS]` when one of them is invoked without Spike.

## Read the facts

```bash
python3 {skills-root}/eque2-code-agent-spike/scripts/spike-status.py {project-root}
```

It is read-only and reports every spike goal (a goal folder holding
`experiment-brief.md`) with its state, loop, criteria, ledger, verdict, and
journal entries not yet in the main checkout. `--help` documents the ledger,
the safety fields, and the sweep rules. When `main_checkout` is `false`, this
conversation runs inside a worktree — perhaps a spike's own: **write
nothing**. Report what the script found, name the main checkout, and ask the
developer to run Spike there. When it is `null`, this is not a git checkout,
and goal worktrees cannot exist: report that and write nothing.

If the script cannot run, read the goal folders and ledgers by hand and
**report only** — tear nothing down without the script's loop check.

## Tear down what is left — only where `sweep` says `tear-down`

| `sweep` | What Spike does |
|---|---|
| `tear-down` | For each outstanding entry with `auto: true`, run its `delete` command, then prove the resource is gone with a command that would show it (for example `docker ps -a --filter name=<name>` returning nothing). An entry with `auto: false` has a delete command that is not a known delete verb aimed only at its own resource or tag (`rm` and `find` never are): show the command to the developer and run it only on their word. |
| `leave-running` | Touch nothing. The spike's loop is running; its resources are in use. |
| `loop-unknown` | Touch nothing. The loop state cannot be read, so the resources may be in use. Name the check: `bash {skills-root}/eque2-code-goal-gate/cancel.sh status <worktree>`. |
| `clean` | Nothing to do. When `ledger.found` is false on a `stale` spike, its ledger never reached the branch: report "check by tag `spike:<slug>`". |
| `check-by-tag` | A lost spike (state `lost`): its worktree and branch are both gone. Report "check by tag `spike:<slug>`"; there is nothing to read or run. If the developer retired it on purpose, its `<slug>.moved` stub can be deleted — say so once. |

Record each teardown, with its proof, as one line in
`{project-root}/_bmad-output/goals/<slug>.sweep.jsonl`:
`{"event": "torn-down", "name": "<name>", "proof": "<command> -> <observed result>", "at": "<ISO-8601 UTC>", "by": "spike-sweep"}`.
Never edit a spike's own `resources.jsonl` — it is the loop's evidence. A
`delete` that fails, or a proof that still shows the resource, is not a
teardown: leave the entry outstanding and report the command, its output, and
the resource's tag (`spike:<slug>`) so the developer can find it. A malformed
ledger line is reported with its source and line number; never guess what it
meant. After any teardown, run the script again: an entry still outstanding
is reported, not assumed gone.

## Bring journal entries home

For each spike whose loop is not `active`, copy every `journal_not_home`
entry into `{project-root}/_bmad-output/journals/<journal-workstream>/`
byte for byte — `cp <source> <dest>`, or for a `git:<branch>:<path>` source
`git show <branch>:<path> > <dest>`; never retype it — prepend its
`index_line` to that workstream's `JOURNAL.md` (create the index if absent; when
`index_line` is null, write one from the entry's date, verdict, and title),
and reconcile `STATE.md` by the rules of `eque2-code-journal`. Never overwrite
an entry that already exists in the main checkout. This is what lets the next
`[PS]` see a rejected spike's dead end.

## Report, then hand back

One short block, verdict first: each spike whose loop has ended, with its
verdict and its next step (`adopt` → `[AS] <slug>`, which starts the promotion
or reports the one under way; `reject` or `inconclusive` → the journal entry
that records it). Then what the sweep tore down (with proof), what still waits,
spikes left running, entries brought home, and anything that needs the
developer — an `auto: false` delete, a failed teardown, an unknown loop, a
malformed ledger line, a check by tag. Name the files the sweep wrote into the main
checkout; they are uncommitted, and the developer commits them. "Nothing left
behind" is the one-line report when all is clean.

Then proceed to the step that called the sweep.
