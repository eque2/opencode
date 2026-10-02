# Format 2 — a task file and a verify file for each unit

```
2-task-and-verify-pairs/
  T2-services/
    T2.task.md                                        parent: intent and the subtask list
    T2.verify.md                                      parent: how the phase as a whole is judged
    T2.1-database-source.task.md                      what to do
    T2.1-database-source.verify.md                    how it is judged
    …                                                 one pair per subtask
  acceptance.md                                       the 26 scenarios, shared
  gates.md · verification-policy.md · refs.md
```

## Grammar

- `*.task.md`: YAML front matter (`id`, `title`, `parent`, `after`, `touches`, `refs`), then the headings
  `Goal`, `Approach`, `Preserve`, `Must not`, `Not in this task`, `Change detail`.
- `*.verify.md`: YAML front matter (`verifies`, `supports`, `gates`, `proof`, `hint`), then `Cases`,
  `Acceptance this task contributes to`, `Weak proofs to reject`, `Evidence`.
- The pair is linked twice: by file stem, and by `verifies:` naming the task id. The engine refuses a verify
  file whose `verifies` does not match its stem.

## Where verification lives

In its own file, beside the work. The split follows the roles: a builder needs the task file and the cases; a
verifier needs the verify file and the code. What each role sees becomes a policy choice — for example, whether
the builder also reads the `Weak proofs to reject` rubric.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts.

## Strengths

- Separation of duties is visible in the file system.
- Verification can be owned and changed by someone other than the task author, with a clean diff.
- Front matter gives the engine typed fields without parsing bold labels.

## Weaknesses

- Twice the files; a reader jumps between two tabs for one unit of work.
- The pair can drift: a case added to the task's intent but not to the verify file goes unproved. The engine
  can only check the link, not the meaning.
- Shared scenarios still need a third home (`acceptance.md`).
