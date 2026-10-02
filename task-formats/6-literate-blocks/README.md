# Format 6 — literate markdown with typed blocks

```
6-literate-blocks/
  T2-services.md      a design note with fenced, typed blocks (723 lines)
```

## Grammar

One rule: a fenced code block whose info string starts with a known type is data; everything else is prose.

| Block | Info string | Content |
| --- | --- | --- |
| task | `task T2.1` | YAML: `title`, `after`, `touches`, `preserve`, `must-not`, `not-here`, `refs` |
| verify | `verify T2.1` | YAML: `supports`, `gates`, `hint`, `cases`, `rejects` |
| scenario | `gherkin S25` | Gherkin; the id in the info string must match the `Scenario:` line |
| gate | `gate BUILD-2` | YAML: `title`, `run`, `needs` |
| policy | `policy` | YAML: the verification defaults |
| refs | `refs` | YAML: id → statement |

Prose belongs to the nearest heading above it; the engine passes the prose of a task's section to the
builder with the blocks. Blocks may be split across any number of `.md` files in a folder: the engine collects
them all and refuses duplicate ids.

## Where verification lives

In a `verify` block right after its `task` block. The pairing is by id, so the two blocks could also live in
different files.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts.

## Strengths

- Reads as a design document: the why and the what sit together, in the order a human explains them.
- The grammar is one rule plus a YAML schema per block type — the easiest format to parse robustly.
- Flexible packaging: one file per phase, one per task, or blocks spread across files.
- Renders cleanly in any markdown viewer; the blocks show up as code.

## Weaknesses

- YAML inside fences gets no editor help unless the tooling is taught the block types.
- Freedom of layout means two authors lay out the same phase differently.
- Long text inside YAML (`>-` scalars) is less pleasant to edit than plain markdown lists.
