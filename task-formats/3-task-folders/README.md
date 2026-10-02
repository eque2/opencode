# Format 3 — `.task` folders

```
3-task-folders/
  provider-ordering-admin.spec/                 a spec folder (the feature)
    SPEC.md                                      policy, gates, references — inherited by every task
    acceptance/S3.md … S59.md                    one file per scenario
    T2-services.task/                            a task folder: TASK.md required, VERIFY.md required
      TASK.md
      VERIFY.md
      T2.1-database-source.task/                 a child task folder
        TASK.md
        VERIFY.md
      …                                          six child folders
```

## Grammar

The suffix is the contract:

- `*.spec/` must hold `SPEC.md`; it may hold `acceptance/` and `*.task/` folders.
- `*.task/` must hold `TASK.md` and `VERIFY.md`. It may hold child `*.task/` folders (subtasks) and a `refs/`
  folder of attachments (fixtures, sample payloads, screenshots). Any other file is an error, so nothing slips
  in unparsed.
- The folder name is `<id>-<slug>.task`; `TASK.md`'s `id` must match the prefix.
- Nesting is the hierarchy. `after:` holds ids, not paths, so a task can move without breaking its dependants.
- `VERIFY.md` inherits `SPEC.md`'s policy. A task can tighten one line — for example, a task that needs a live
  database — without restating the rest.

This mirrors the `.goal` folders the goal workflow already uses.

## Where verification lives

`VERIFY.md` in the task's own folder. Scenarios live once, under `acceptance/`, and every task links to them.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts. A natural home is a parallel tree outside the spec — for example `.state/T2-services/T2.1/` — that
mirrors the folder path.

## Strengths

- The structure is enforced by the engine, not by convention: a missing `VERIFY.md` is a load error.
- Room to grow: fixtures, prompts and golden files sit with the task that needs them.
- An agent can be handed one folder: exactly the context for one unit of work.
- Moving or renumbering a task is a folder rename.

## Weaknesses

- Deep paths, and many small files to open for a phase overview.
- Folder names carry the id and the slug, so a retitled task leaves a stale slug unless the engine renames
  it.
- Tooling (editors, review UIs) shows folders less well than one long file.
