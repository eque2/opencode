---
name: task-ui — /task harness feedback
status: final
sources:
  - ../decisions.md
  - ../ACs.md
  - ../task-questions.md
  - ../plan.md
  - ../architecture/ARCHITECTURE-SPINE.md
updated: 2026-10-14
---

# task-ui — Experience Spine

How a `/task` run reads in the opencode TUI after the task-harness-feedback goal: the run header, the reasons, the
blocked cascade, the outside wait, the scenarios, the task durations, the run's cost, the animated diamond and the
closing summary. The approved decisions D1–D27 bind this document. It sets what D4, D10, D12, D13 and D16–D24 hand to
UX, and it re-decides none of them. The architecture spine (`../architecture/ARCHITECTURE-SPINE.md`) owns the
`status.json` contract (AD-13), the refusal and warning lines (AD-14), subtree runs (AD-15), the task-ui view machine
(AD-16) and the closing summary's seam (AD-18). This document uses its names.

## Foundation

- **Form factor.** Terminal UI, any width. opencode's TUI renders with opentui and Solid. The task-ui is the built-in
  plugin `internal:task-ui` (`packages/tui/src/task-ui/`). The run header, the refusal and the closing summary are
  messages in the root session's transcript (`packages/tui/src/routes/session/index.tsx`). The run's cost also shows
  in the prompt footer (`packages/tui/src/component/prompt/index.tsx`) and in the sidebar Context panel
  (`packages/tui/src/feature-plugins/sidebar/context.tsx`).
- **Visual identity.** There is no DESIGN.md. The visual reference is the opencode TUI theme: the `Theme` type in
  `packages/tui/src/theme/index.ts`, the theme files in `packages/tui/src/theme/assets/*.json` (`opencode.json` is the
  default), and the resolution in `packages/tui/src/context/theme.tsx`. This document cites colours as
  `{theme.<token>}`, a field of that `Theme` type: `{theme.text}`, `{theme.textMuted}`, `{theme.accent}`,
  `{theme.primary}`, `{theme.success}`, `{theme.info}`, `{theme.warning}`, `{theme.error}`,
  `{theme.backgroundPanel}`, `{theme.backgroundElement}`. "Bold" is the opentui `<b>` attribute. No surface uses a colour outside the theme.
- **Data.** The task-ui reads `<directory>/.opencode/task/status.json` once a second, through the `feed` region of
  the `taskView` machine (AD-16). The field names are those of AD-13: `run` (`state`, `tags`, `reason`, `warning`,
  `spec`, `specId`, `path`, `title`, `task`, `startedAt`, `endedAt`, `aliveAt`), `tasks[id]` (`state`, `tags`,
  `attempts`, `waitingOn`, `waitingOnOutside`, `reason`, `blockedBy`, `startedAt`, `endedAt`, `spans`),
  `obligations[id]` (`state`, `tags`, `reason`), `scenarios[id]` (`state`, `tags`, `title`, `waitingOn`,
  `waitingOnOutside`, `reason`, `blockedBy`, `startedAt`, `endedAt`), `outside` and `external`. This document writes
  `tasks[].x` for a field of any task. The status tags are `active`, `waiting`, `ended`, `stopped`, `blocked` and `dead`.
- **Liveness.** The `liveness` region of the view machine (AD-16) is `live` while the run lacks the `ended` tag and
  `run.aliveAt` is at most 15 s old. It is `still` when the heartbeat is older or absent, and `ended` on the `ended`
  tag, and `absent` with no status file. A run that waits on `/task trust` inside a live job keeps its heartbeat, so
  it stays `live`. The `liveness` region replaces today's `live` check and its 5-minute `LIVE_WINDOW`: Tab, `esc`
  twice, the watch keys and the watch band act while `liveness` is `live` and the root session owns the run's
  harness sessions (the existing `owns` check). In this document, "live" means `liveness` `live`.
- **Classification.** Every grouping in this document (Board column, STOPPED group, live or fixed duration, animated
  or static diamond) comes from the status tags, the `liveness` region and the status times (D8, D16, AD-16). The
  task-ui derives nothing from `history`. The one table keyed by state names is the display table (AD-16; `DISPLAY`
  in AD-17): state to glyph, tone and Gantt block. A design uses a unit's `state` only as a key into that table.

## Information Architecture

| Surface | Reached from | Purpose | Changed by |
|---|---|---|---|
| Run header message | `/task <path>` | First message of the run in the root transcript | D17 |
| Refusal message | `/task <path>` on a faulty spec or subtree | Every reason the run did not start | D10, D13, AD-14 |
| Busy reply | `/task <path>` while a run is live in the directory | Names the live run; one run at a time | AD-19 |
| Closing summary | The run reaches a final state | The outcome, the reasons, the durations and the cost, in the main body | D18 |
| Prompt footer usage | A `/task` root session | The run's summed tokens and cost | D24 |
| Sidebar Context panel | Sidebar (automatic above 120 cells) | The run's summed tokens and cost | D24 |
| Shortcut bar | Bottom right of the input box | In the Flow mark, design name, status parts, keys | D22, D23, D12, D4 |
| Design 1 Ledger | Sidebar, `/task-design`, `ctrl+x v` | Task tree; expanded: details under it | D17, D19, D20, D23 |
| Design 2 Dock | Bottom strip | One status line; expanded: details above it | D19, D20, D23, D24 |
| Design 3 Board | Full screen on `ctrl+x o` | Columns of task stages | D16, D19, D20, D21 |
| Design 4 Matrix | Full screen on `ctrl+x o` | Grid of proofs and scenarios | D19, D20, D21 |
| Design 5 Gantt | Full screen on `ctrl+x o` | The run as time | D16, D19, D20, D21 |
| Design 6 HUD | Floating panel, top right | Instrument panel; expanded: details under it | D19, D20, D21, D23, D24 |
| Design 7 Ticker | Shortcut bar parts, toasts, dialog on `ctrl+x o` | The quietest design | D19, D20, D23, D24 |
| Peek | Every expanded view | One task's builder, proofs and verifier | D19, D21 |
| Shared region | Every expanded view | Run warning list, outside wait lines, STOPPED list, SCENARIOS list | D12, D4, D19, D20 |
| Watch band | `ctrl+x w` | What is watched, or why nothing is | D4 |

Every expanded view holds three blocks: the design's own content, the **Peek**, and the
[shared region](#shared-region-d4-d12-d19-d20). [Design placement](#design-placement) gives each design's layout.

## Voice and Tone

Microcopy rules for every surface in this document:

- Name the unit first, then what happened: "T1.5 blocked by T1.4: budget exhausted".
- Use the state labels: the status state with `_` shown as a space ("budget exhausted", "needs human").
- Use "waiting on" for every wait, and "is after" for an order. Do not use "waits on" or "depends on".
- Write commands literally, so the user can type them: "run /task trust T9".
- Write counts as `k/n`: "3/6 trusted", "Scenarios 4/13 trusted".
- The header, the refusal, the busy reply and the summary drop the "Task harness:" prefix. The other `/task` replies
  (usage, trust) keep their text.
- No exclamation marks, no emoji, no apology.
- Lines that the status carries show verbatim: `run.reason`, `run.warning`, `tasks[].reason`, `scenarios[].reason`,
  `obligations[].reason`.
  These rules cover the microcopy around them, so the AD-4 line "not run: S13 waits on T8" keeps its wording.

| Do | Don't |
|---|---|
| "Implementing spec **Release notes from conventional commits**" | "Task harness: running task-formats/blend/release-notes.spec in the background. Its status is in .opencode/task/status.json." |
| "T1.5 blocked by T1.4: budget exhausted" | A T1.5 card in WAITING that never moves |
| "waiting on T9 (outside) — run /task trust T9" | "waits on T9" |
| "Refused task-formats/blend/example-format-faults.spec: 3 failures. No work started." and one line for each failure | "refused …: R1 notes.txt: …" (the first failure only) |
| "! spec no longer validates · 2 failures" | No message when the spec breaks during the run |
| "Spec **Release notes from conventional commits** — budget exhausted" | "the task run of release-notes.spec ended budget_exhausted" |
| "run 1.4M tokens · $2.31" | "$0.00" on a run that spent tokens |
| "no builder session: the task did not start" (a task that ended and never started) | "no builder session yet" (a session that will never come) |
| "Not started: the run of task-formats/blend/release-notes.spec is live in this directory (/task task-formats/blend/release-notes.spec). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice." | "Task harness: the run of task-formats/blend/release-notes.spec is already going on." |
| "waiting on T1.1 (not in this run)" (an external task) | "run /task trust T1.1" for a folder task |

## State vocabulary

The display table (AD-16): a state to its glyph, its tone and its Gantt block. The tone colours the glyph, the id, the
card border and the Gantt block. **New** marks a new row. The tags column repeats the AD-13 class table for the
reader: the tags, not this table, decide every grouping.

| State | Glyph | Tone | Gantt block | Board column | Tags of a task (AD-13) |
|---|---|---|---|---|---|
| waiting | `○` | `{theme.textMuted}` | `░` | — | `waiting` |
| building | `◐` | `{theme.primary}` | `▓` | BUILDING | `active` |
| proving | `◑` | `{theme.primary}` | `▒` | PROVING | `active` |
| verifying | `◒` | `{theme.primary}` | `▞` | VERIFYING | `active` |
| trusted | `✓` | `{theme.success}` | `█` | — | `ended` |
| failed | `✗` | `{theme.error}` | `█` | — | `ended`, `stopped`, `dead` |
| budget exhausted | `⊘` | `{theme.error}` | `█` | — | `ended`, `stopped`, `dead` |
| needs human | `?` | `{theme.warning}` | `█` | — | `ended`, `stopped`, `dead` |
| **blocked** | `⊖` | `{theme.warning}` | `█` | — | `ended`, `stopped`, `blocked` |
| cancelled | `–` | `{theme.textMuted}` | `█` | — | `ended`, `stopped` |
| pending (scenario, obligation) | `·` | `{theme.textMuted}` | — | — | `active` for a scenario, `waiting` for an obligation |
| rejected (scenario, obligation) | `✗` | `{theme.error}` | — | — | `ended`, `stopped` for a scenario |
| passed (obligation) | `◉` | `{theme.info}` | — | — | `active` |
| stale (obligation) | `~` | `{theme.warning}` | — | — | `waiting` |
| stalled | `‼` | `{theme.warning}` | `█` | — | none: no state has this name (AD-13); the row stays for an older file |

The same table serves tasks, scenarios and obligations: a state name keys one row, whatever the unit. A parked
scenario shows as waiting (AD-13). The Board column field is a display key only: the tags choose the column.

**Board column** (AD-16). A task with the `waiting` tag goes to WAITING. A task with the `active` tag goes to the
column that the display table gives its state: BUILDING, PROVING or VERIFYING. A task with the `stopped` tag
goes to STOPPED. A task with the `ended` tag and without `stopped` goes to TRUSTED.

**STOPPED group** (AD-16). Group 1 is every task with the `dead` tag. Group 2 is every task with the `blocked` tag.
Group 3 is the rest of the `stopped` tasks. Within a group, tasks keep tree order. Inside one shared line, the ids
are in natural order ("T1, T1.5"). Every other list that sorts by
severity uses the AD-16 order: `dead`, `blocked`, `stopped`, `active`, `waiting`, `ended`.

**Durations.** A task with `startedAt` and no `endedAt` is live while `liveness` is `live`. A task with `endedAt` is
fixed. A task with no `startedAt` (waiting, or blocked before it started) is blank.

## Component Patterns

Behavioural rules. Text in the mocks is illustrative; widths are in terminal cells.

| Component | Where | Rule |
|---|---|---|
| Run header message | Root transcript, first | [Run header](#run-header-d17) |
| Refusal message | Root transcript, instead of the header | [Refusal](#refusal-d10-d13) |
| Busy reply | Root transcript, while another run is live | [Refusal](#refusal-d10-d13) |
| Closing summary | Root transcript, last | [Closing summary](#closing-summary-d18) |
| Run warning | Collapsed views, shared region, toast | [Run warning](#run-warning-d12) |
| Outside wait line | Collapsed views, shared region, shortcut bar | [Outside wait line](#outside-wait-line-d4) |
| In the Flow mark | Every `Brand` element | [In the Flow mark](#in-the-flow-mark-d23) |
| Shortcut bar | Bottom right of the input box | [Shortcut bar](#shortcut-bar-d22) |
| Shared region | Every expanded view | [Shared region](#shared-region-d4-d12-d19-d20) |
| STOPPED list | Shared region | [STOPPED list](#stopped-list-d19) |
| SCENARIOS list | Shared region | [SCENARIOS list](#scenarios-list-d20) |
| Board card | Board columns | [Board card](#board-card-d16) |
| Peek BUILDER heading | The Peek, in every expanded view | [Peek BUILDER heading](#peek-builder-heading-d19-d21) |
| Duration | Gantt, Matrix, Board, HUD, Peek | [Durations](#durations-d21) |
| Gantt lane | Gantt rows | [Durations](#durations-d21) |
| Run usage | Prompt footer, sidebar, task-ui | [Run usage](#run-usage-d24) |
| Run reason line | Ledger, full-screen header, Dock, HUD, Ticker notification | The first line of `run.reason`, then " (+N more)" when it has more lines: "T1.4 budget exhausted (+2 more)", "acceptance not proved: S4 rejected". `{theme.error}` when the run has the `stopped` tag. A `done` run can carry "not run" lines (AD-4 rule 4); they show in `{theme.warning}`. A refused run is the exception: the Ledger and the full-screen body show every `run.reason` line. |
| Stopped count | After every `k/n trusted` | "· 2 stopped" in `{theme.error}`, only when the count is above 0. The count is the number of tasks with the `stopped` tag. |
| Ticker toast | Design 7, on each task change | A task that gains the `dead` or the `blocked` tag shows its `reason` in place of "from → to": "T1.5 blocked by T1.4: budget exhausted". A task comes before the tasks that it blocks. At most three toasts for one change, as today. |
| Watch band idle text | Watch view with nothing running | Names an untrusted id of `waitingOnOutside` with the command: "Nothing is running. The run is waiting on T9 (outside) — run /task trust T9." An external id never gets the command. |

### Run header (D17)

The first message of a run carries its own structured field (AD-13): its text part holds
`metadata.taskHarness.header = { spec: { id, title }, task?: { id, title }, leftOut }`. The TUI draws the header from
that metadata (D17). It never reads `status.json`, so an older header in scrollback keeps its own title when a later
run starts. The header keeps the existing user-message panel.

```
┃  Implementing spec Release notes from conventional commits
```

- "Implementing spec" is `{theme.textMuted}`. `header.spec.title` is bold `{theme.text}`.
- Subtree run (`header.task` present): "Implementing" muted, "T1.2 Compute the next version" bold, "from spec" muted,
  the spec title bold.
- An empty `header.spec.title` falls back to `header.spec.id`, in the same bold style. Nothing marks the fallback.
- A non-empty `header.leftOut` (D13, AD-15) adds one `{theme.textMuted}` line: "Left out: S1, S5 — they need tasks
  outside this run."
- The header wraps at word boundaries in the panel. It never cuts the title.
- The task-ui shows `run.title` where it shows the spec folder name today: on its own line in the Ledger, and in the
  muted segment of the full-screen header ("Release notes from conventional commits · run: running"). `run.title`
  already holds `specId` when the H1 is empty (AD-13). Both places cut the title with `…`.

### Refusal (D10, D13)

A refused `/task` writes a plain-text session message (AD-14): one header line, then exactly the lines of
`run.reason`, then one optional hint line. `run.reason` holds only the failure lines (D10).

```
┃  Refused task-formats/blend/example-format-faults.spec: 3 failures. No work started.
┃  R1 <path>: <message>
┃  R4 <path>: <message>
┃  R3 <path>: <message>
┃  Fix each line, then type /task task-formats/blend/example-format-faults.spec again.
```

| Refusal | Header line | Lines | Hint line |
|---|---|---|---|
| Loader failures (D10) | "Refused <path>: N failures. No work started." ("1 failure" for one) | Each `R<n> <path>: <message>`, in loader order | "Fix each line, then type /task <path> again." |
| Subtree with an untrusted folder task outside it (D13, AD-15) | "Refused <path>: N failures. No work started." | Each `R12 <task folder>: T1.2 is after T1.1, which is outside this run and not trusted` | "Run the whole spec, or a folder that holds T1.1." (every other id named, joined by "and") |
| A plain line with no rule (the git checks) | "Refused <path>. No work started." | The one plain line | none: the line says what to do |

- `<path>` is the `/task` argument as the user typed it.
- The Ledger shows `run: refused` and every `run.reason` line in `{theme.error}`, each line cut to the width. The
  full-screen views show the [run reason line](#component-patterns) in the header, then "No work started: the spec was
  refused." and every `run.reason` line in the body, because a refused run has no tasks to draw. The Dock and the HUD
  show the run reason line. The hint is not in `run.reason`, so only the transcript shows it.
- While a run is live, a faulty spec still gets its refusal, in the session only: it never writes `status.json`
  (AD-19), so the task-ui keeps showing the live run. A valid spec gets the busy reply.

**Busy reply** (AD-19). A `/task` while a run is live in the directory starts nothing and answers with one plain line
that names the live run's spec and path:

```
┃  Not started: the run of task-formats/blend/release-notes.spec is live in this directory (/task task-formats/blend/release-notes.spec). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice.
```

- It is one line; the panel wraps it at word boundaries.
- The spec is the live run's spec folder and the path is its `/task` argument, both from the directory lease. The
  lease holds no session, so the reply names none.
- The same line answers a second `/task` of the same spec. It replaces today's "the run of … is already going on".

### Closing summary (D18)

One assistant-role markdown message at the end of the run (D18), written through `Ops.say` (AD-18). The `summary`
actor builds it from `project(plan, snapshot)` and from the session store's sums. The session's markdown renderer
draws it, with grid tables.

```markdown
Spec **Release notes from conventional commits** — budget exhausted

Tasks 3/6 trusted · 1 budget exhausted · 2 blocked · Scenarios 4/13 trusted · 1 rejected · 8 blocked · 24m 10s · 1.4M tokens · $2.31

**Stopped**

- ⊘ **T1.4** budget exhausted after 3 attempts · 6m 40s
  T1.4.c7 rejected: the multiline-message test asserts only that "topic change" appears
- ⊖ **T1**, **T1.5** blocked by T1.4: budget exhausted

**Scenarios that did not pass**

- ✗ **S4** rejected · Notes are grouped under fixed headings
  <verdict reason>

**Tasks**

| Task | State | Attempts | Time |
|---|---|---|---|
| T1 | blocked | 0 | — |
| T1.1 | trusted | 1 | 3m 2s |
| T1.2 | trusted | 1 | 2m 40s |
| T1.3 | trusted | 2 | 5m 12s |
| T1.4 | budget exhausted | 3 | 6m 40s |
| T1.5 | blocked | 0 | — |
```

- **Outcome line.** "Spec **<title>** — <outcome>", from `run.title` and the label of `run.state`. A subtree run reads
  "**T1.2 Compute the next version** from spec **<title>** — <outcome>", from `run.task`. The outcome line takes the
  first form that applies, in the order of the AD-4 rules (owner answer of 2026-10-14):

  | AD-4 rule | Case | Outcome line |
  |---|---|---|
  | 1 | The slice's history holds a stop note (`run.cancelled`, or `run.ended` such as the run wall clock) | Spec **<title>** — <label of `run.state`>: <first line of `run.reason`> |
  | 2 | A task has the `dead` tag | Spec **<title>** — <label of `run.state`>, for example budget exhausted |
  | 3 | `run.state` is `failed` with no stop and no dead task: a scenario failed or was rejected | Spec **<title>** — failed: acceptance not proved |
  | 4 | `run.state` is `done` | Spec **<title>** — done |

  Rules 3 and 4 add " · 1 scenario not run" or " · N scenarios not run" when scenarios still have the `waiting` tag.
  The summary actor reads the stop note from the slice's history, as it reads `spec.checked` (AD-18).
- **Counts line.** "Tasks k/n trusted", then one count for each other task state above zero. Then "Scenarios k/n
  trusted", then one count for each other scenario state above zero, with "not run" for a scenario still tagged
  `waiting` (the scenario part is left out when the run has none). Then the run's duration (`run.endedAt` −
  `run.startedAt`), the tokens and the cost ([Run usage](#run-usage-d24) format).
- **Stopped.** Every task with the `stopped` tag, with its full `reason`, never cut. Grouping and order follow the
  [STOPPED list](#stopped-list-d19). Newlines in a reason become spaces. The section is left out when it is empty.
- **Scenarios that did not pass.** Each scenario with the `stopped` tag and without `blocked`, with its glyph, its
  state label, its title and its full `reason`. Scenarios with the same state and the same `reason` share one entry.
  Left out when it is empty. This holds every rejected scenario that D18 names; blocked scenarios are in the counts
  line.
- **Not run.** Each scenario still tagged `waiting` when the run ended: "○ **S13** The published package runs from the
  registry — waiting on T8 (outside)". Left out when it is empty. The run's own line for it ("not run: S13 waits on
  T8") stays in `run.reason`.
- **Tasks.** One row for each task in tree order: id, state, `attempts`, duration (`endedAt` − `startedAt`). "—" for a
  task with no `startedAt`. The table has no title column.
- **Run warning.** When the slice's history holds a `spec.checked` entry with failures (D12, AD-18), one line comes
  before **Tasks**: "The spec stopped validating during the run. The run kept the plan it loaded."

### Run warning (D12)

While `run.warning` is present, every surface that shows the run state shows it in `{theme.warning}`.

- **One line** (collapsed views, headers, shortcut bar part "! spec"): "! spec no longer validates · 2 failures",
  where 2 is the number of `run.warning` lines.
- **Shared region:** the one line, then each `run.warning` line (`R<n> <path>: <message>`, AD-14), cut to the width,
  then "The run keeps the plan it loaded." in `{theme.textMuted}`.
- **Toast**, once, when the warning first appears, in every design: variant warning, title "◆ In the Flow" (static),
  message "The spec no longer validates (2 failures). The run keeps the plan it loaded."
- The next reload that validates clears `run.warning` (AD-12), and the warning goes from every surface.

### Outside wait line (D4)

D4 sets the text on the Board. The same text shows on every design, so that a run with an outside wait never sits with
no report.

- **Shows when** the run lacks the `ended` tag, and a task or a scenario has an id in `waitingOnOutside` whose
  `outside[id].state` is `untrusted` (AD-16). It goes when `outside[id].state` turns `trusted`. After the run ends, a
  scenario still waiting on an outside id reads "not run" ([SCENARIOS list](#scenarios-list-d20)) and gets no command.
- **Text:** "waiting on T9 (outside) — run /task trust T9", in `{theme.warning}`, one line for each outside id. The
  line wraps at word boundaries and never cuts the command.
- **External ids** (AD-15): an id in `waitingOn` that is a key of `external` reads "waiting on T1.1 (not in this run)"
  in `{theme.textMuted}`, on the card and the Peek heading. It never gets a trust command and never makes an outside
  wait line, because `/task trust` reaches only `outside` regions. The wait is short: AD-15 refuses an untrusted
  external task at the start and records a trusted one directly after `run.started`, and a subtree run leaves out the
  scenarios whose needs fall outside it. `[CS]` proves this text with a fixture status, not with the live check.
- **Collapsed views:** under the run warning line (Ledger, HUD, full-screen header), or as a segment (Dock). With two
  or more outside ids, the collapsed line names the first id and ends with " +N".
- **Shortcut bar:** a part with the key "/task trust T9" and the label "outside wait", in `{theme.warning}`.
- **Shared region:** after the run warning list, one line for each outside id.

### In the Flow mark (D23)

- Every `Brand` element (Ledger header, Dock strip, HUD panel, full-screen header, Ticker dialog, shortcut bar, watch
  band) becomes a row: the `opentui-spinner` element that `component/spinner.tsx` uses, then " In the Flow" as bold
  `{theme.accent}` text.
- The spinner plays the frames `· ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩`, about 120 ms each, in a loop, in `{theme.accent}`.
- The diamond animates only while `liveness` is `live` (AD-16). It is a static `◆` when `liveness` is `still` or
  `ended`, and when the `animations_enabled` setting is off. A run that waits on `/task trust` inside a live job keeps
  its heartbeat, so its diamond keeps moving.
- AC 25 reads "while the run is active" as `liveness` `live` (prepare-goal default of 2026-10-14), not as the run's
  `active` tag: a run that waits on `/task trust` is tagged `waiting` and still animates. A scripted check stamps a
  fresh `run.aliveAt` on its fixture (the `project` fixture has none) or injects `now`. One more check proves that a
  stale `run.aliveAt` makes the diamond static.
- The spinner element cannot draw bold, so the diamond is not bold in either form. It does not change weight when it
  stops.
- The plain-text uses stay static: the Peek border title and the toast title.
- Every frame is one cell wide, so the text after the diamond never moves. The spinner element runs the frames; the
  task-ui adds no timer. Two diamonds on one screen need not be in phase.

### Shortcut bar (D22)

The `/task-design switch` part goes. `/task-design` stays in the command list.

```
◆ In the Flow Ledger  ctrl+x o expand  tab select task  ctrl+x w watch
◆ In the Flow Board  ! spec  ctrl+x o expand  tab select task  ctrl+x w watch  3/6 trusted  · 3 stopped
```

| Design | Parts, in order |
|---|---|
| 1, 2, 6 | run warning, outside wait, keys |
| 3, 4, 5 | run warning, outside wait, keys, trusted count, stopped count |
| 7 | run warning, outside wait, trusted count, stopped count, selected task, keys |

- The keys: `ctrl+x o` expand or collapse; `tab` select task while `liveness` is `live`, else `ctrl+x j/k` select task;
  `ctrl+x w` watch. The watch view keeps its own keys.
- No key takes the place of the old hint. The new status parts (run warning, outside wait, stopped count) use the
  room.
- A narrow bar drops parts from the end, as today. The run warning and the outside wait come first, so a narrow bar
  keeps them.

### Shared region (D4, D12, D19, D20)

One block in every expanded view, in this order: the run warning list, the outside wait lines, the
[STOPPED list](#stopped-list-d19), the [SCENARIOS list](#scenarios-list-d20). A section with nothing to show is
hidden, except the SCENARIOS heading.

- **Scroll.** The region is a scroll box. The mouse wheel scrolls it in every design. In the full-screen views and the
  Ticker dialog, `pageup` and `pagedown` scroll it too. In the Ledger it scrolls with the sidebar.
- **Height.** When the expanded view is taller than the terminal, the Peek's activity lines shrink first, down to 1
  line for each section, so that the region keeps at least 8 rows. The region never drops an entry: an entry out of
  view is reachable by scroll.
- **Keyboard.** A keyboard-only user reaches every entry in a full-screen design or in the Ticker dialog. In the Dock
  and the HUD, the region scrolls with the mouse wheel only, because the prompt keeps the keys.

### STOPPED list (D19)

```
STOPPED 3
⊘ T1.4 budget exhausted — T1.4.c7 rejected: the multiline-mess…
⊖ T1, T1.5 blocked by T1.4: budget exhausted
```

- Heading: "STOPPED <n>", bold `{theme.textMuted}`, as the Board column headings. Hidden when the column is empty.
- Members: every task with the `stopped` tag. The Board shows the list too, so a narrow Board that cuts its STOPPED
  column still shows every reason.
- Order: group 1 (`dead`), then group 2 (`blocked`), then group 3 ([State vocabulary](#state-vocabulary)).
- One line for each set of tasks with the same state and the same `reason`, the ids in natural order: "⊖ T1, T1.5
  blocked by T1.4: budget exhausted". When the ids do not fit, they end with "+N" in `{theme.textMuted}`: "⊖ T1, T1.5,
  +3 blocked by T1.4: …".
- Line format: the glyph and the ids in the state's tone, the state label, then " — " and the `reason` in
  `{theme.textMuted}`. A `blocked` line has no label: its `reason` starts with "blocked by", in `{theme.warning}`.
- Each entry takes one line, cut with `…`. Under 30 cells, the reason goes and the glyph, ids and state stay. The full
  text is in the Peek heading and in the closing summary.
- A click on a line selects its first task, so the Peek shows it.

### SCENARIOS list (D20)

```
SCENARIOS 13 · 3/13 trusted
○ S1 waiting on T1.4 · Release notes and next…   ○ S8 waiting on T1.4 · Bad arguments stop…
✓ S2 trusted · A conventional message is rea…   ○ S9 waiting on T1.4 · A folder that is n…
✓ S3 trusted · The next version follows the …   ○ S10 waiting on T1.4 · An invalid curren…
✗ S4 rejected · Notes are grouped under fixe…   ○ S11 waiting on T1.4 · A machine without…
    <verdict reason, at most 2 lines>            · S12 pending · Every commit in the ran…
○ S5 waiting on T1.5 · Issue references beco…   ○ S13 waiting on T1.4, T8 (outside) · Th…
○ S6 waiting on T1.4 · The default range sta…
✓ S7 trusted · A message that is not convent…
```

- Heading: "SCENARIOS <n> · k/n trusted", bold `{theme.textMuted}`. A run with no scenarios shows
  "SCENARIOS none in this run" in `{theme.textMuted}`.
- Every scenario of the run has one entry, in natural id order: the glyph and the id in the state's tone, the state
  label in `{theme.textMuted}`, " · ", then `scenarios[].title` in `{theme.text}` (AD-13 gives it with no leading
  id).
- A scenario with the `waiting` tag shows its `waitingOn` as a waiting task does: "waiting on T1.4", in
  `{theme.textMuted}`. An id in `waitingOnOutside` adds "(outside)" in `{theme.warning}`.
- Once the run has the `ended` tag, a scenario that still has the `waiting` tag never ran (a parked scenario, AD-2).
  Its label reads "not run" in place of "waiting": "○ S13 not run: waiting on T8 (outside) · The publish…".
- A scenario with the `blocked` tag shows its `reason` in `{theme.warning}`: "⊖ S5 blocked by T1.5: blocked ·
  <title>".
- A scenario with the `stopped` tag, without `blocked`, and with a `reason` has the `reason` under its entry,
  indented 4 cells, in its state's tone (display table: `{theme.error}` for rejected and failed, `{theme.textMuted}` for
  cancelled), wrapped to at most 2 lines and cut with `…`.
- Columns: one column when the region is under 80 cells wide. From 80 cells, two equal columns, filled column first
  (the first half of the entries on the left). Each column stacks its own entries, so a reason under an entry moves
  only its own column.
- Cutting: the glyph, the id and the state label are never cut. The title keeps at least 12 cells. The wait ids are
  cut before the title goes below 12 cells.
- Check: a scripted render of the release-notes status at 120 × 40 holds S1–S13 in the region of each design.

### Board card (D16)

```
╭────────────────────╮  ╭────────────────────╮  ╭────────────────────╮
│ ⊘ T1.4             │  │ ⊖ T1.5             │  │ ○ T1.5             │
│ budget exhausted   │  │ blocked by T1.4:   │  │ waiting on T1.3,   │
│ attempt 3 · 6m 40s │  │ budget exhausted   │  │ T1.4               │
│ proofs 6/7         │  │ proofs 0/2         │  │ waiting on T9      │
│ T1.4.c7 rejected:  │  ╰────────────────────╯  │ (outside) — run    │
│ the multiline-mes… │                          │ /task trust T9     │
╰────────────────────╯                          ╰────────────────────╯
```

- Line 1: the glyph and the id, bold, in the state's tone. The border takes the state's tone. The selected card takes
  `{theme.accent}` and `{theme.backgroundElement}`, as today.
- Line 2, the state line: the state label in `{theme.textMuted}`, or a sentence when the task has one. A task with the
  `blocked` tag shows its `reason` ("blocked by T1.4: budget exhausted") in `{theme.warning}`. A task with the
  `waiting` tag shows its `waitingOn`: the plan ids as "waiting on T1.3, T1.4" in `{theme.textMuted}`; each untrusted
  id of `waitingOnOutside` as "waiting on T9 (outside) — run /task trust T9" in `{theme.warning}`; each external id as
  "waiting on T1.1 (not in this run)" in `{theme.textMuted}`. A task with more than one kind of wait shows each
  sentence, the plan ids first. Sentences wrap at word boundaries with no line limit. The trust command is never cut.
- Line 3: "attempt N · <duration>" in `{theme.textMuted}`, from `attempts`, `startedAt` and `endedAt`. It shows
  "<duration>" alone for a task with `startedAt` and no attempt. It is left out for a task with neither. When the line
  does not fit the card, the duration moves to its own line under "attempt N". The duration is never cut.
- Line 4: "proofs k/n", as today.
- Reason: a task with a `reason` and without the `blocked` tag shows it, wrapped at word boundaries, at most 3 lines,
  cut with `…`, as today: in `{theme.error}` with the `dead` tag, in `{theme.textMuted}` without it.
- STOPPED column order: the STOPPED list order (groups, then tree order).

### Peek BUILDER heading (D19, D21)

```
╔ ◆ In the Flow · T1.4 details · read-only ═══════════════╗
║ BUILDER  budget exhausted · attempt 3 · 6m 40s          ║
║          T1.4.c7 rejected: the multiline-message test   ║
║          asserts only that "topic change" appears       ║
║   › bash bun test src/cli.test.ts                       ║
```

- **A task with a `reason` and without the `blocked` tag:** line 1 is the state label, "attempt N" when `attempts` is
  above 0, and the duration, joined by " · ", in `{theme.text}`. The `reason` follows on the next lines, in
  `{theme.error}` with the `dead` tag and in `{theme.textMuted}` without it.
- **A task with the `blocked` tag:** line 1 starts its `reason`, "blocked by T1.4: budget exhausted", in
  `{theme.warning}`.
- **A task with the `waiting` tag:** line 1 starts the wait sentences of the [Board card](#board-card-d16), in the
  same tones.
- **Any other task:** line 1 only, as for a task with a `reason`.
- **Wrapping.** A reason or a sentence that does not fit continues on the next lines, with a hanging indent of 9
  cells, under the heading text. It wraps at word boundaries with no line limit, so the full reason is readable during
  the run. The Peek's activity lines shrink first to make room.
- **Did not start.** A task with `endedAt` and no `startedAt` has no sessions. The fallbacks read "no builder session:
  the task did not start" and "no verifier session: the task did not start".

### Durations (D21)

- **Source.** `tasks[].startedAt` and `tasks[].endedAt` (D8, D21, AD-5). For the run: `run.startedAt` and
  `run.endedAt`. The freeze time is `run.aliveAt`.
- **Format.** Under a minute "45s"; under an hour "3m 12s"; from an hour "1h 4m". The task-ui's `elapsed` format gains
  the hour form, so the HUD elapsed time and the Gantt axis use it too. In a column of durations, the duration is
  right-aligned in a 7-cell field in `{theme.textMuted}`. Inline, it takes the colour of its line.
- **Live.** While `liveness` is `live`, a task with `startedAt` and no `endedAt` shows now minus `startedAt`, refreshed
  by the view machine's 1 s `feed` (AD-16).
- **Still.** While `liveness` is `still`, the same task shows `run.aliveAt` minus `startedAt`: the count stops at the
  last heartbeat of the job (AD-16 prepare-goal default). With no `run.aliveAt` (a file from before this change), it
  shows nothing.
- **Fixed.** A task with `endedAt` shows `endedAt` minus `startedAt`. It changes only when a stale check reopens the
  task, which clears `endedAt` and starts `startedAt` again (AD-5).
- **AC 23.** AC 23 reads "live while the task runs" as `liveness` `live`. A scripted check stamps a fresh
  `run.aliveAt` or injects `now`. One more check proves that a stale `run.aliveAt` stops the count.
- **Blank.** A task with no `startedAt` shows nothing. A column keeps its space.
- **Run span.** From `run.startedAt` to `run.endedAt`; to now while `live`; to `run.aliveAt` while `still`. The HUD
  elapsed time and the Gantt axis use it.

| Design | Position | Collapsed |
|---|---|---|
| 1 Ledger | Peek heading | no |
| 2 Dock | Peek heading | no |
| 3 Board | Card line 3; Peek heading | no |
| 4 Matrix | A `time` column after the last proof cell, after a 2-cell gap; Peek heading | no |
| 5 Gantt | Right column: the duration (7 cells), a space, the state text (21 cells); Peek heading | no |
| 6 HUD | Selected-task line; Peek heading | yes |
| 7 Ticker | Peek heading in the dialog | no |

**HUD selected-task line.** The state text is cut first; the duration never is. At the 40-cell inner width:
"▸ ⊘ T1.4 budget exhausted · at… · 6m 40s".

**Gantt lane** (AD-5, AD-16). The lane draws `tasks[].spans` across the run span. Each cell shows the span that
holds the cell's middle time, as the Gantt block of that span's `state` in its tone (display table). A span with no
`to` runs to now while `live`, and to `run.aliveAt` while `still`. Cells before the first span and after the last span
are blank: the Gantt infers no state. A zero-length span (the final state, `to` equal to `from`) takes the one cell
that holds its time, so the state each task ended in always shows. The run span keeps today's tail of 3% after
`run.endedAt`, so a task that ends last still gets its cell. A retry shows as repeated `▓▒▞` runs. A blocked task is
`░` from the run's start, then one `█` cell in `{theme.warning}`. The legend reads "░ waiting ▓ building ▒ proving ▞
verifying █ ended, in its state's colour".

**Matrix legend.** It adds "⊖ blocked". A blocked task's proof cells show their own states, as today.

### Run usage (D24)

The summed tokens and cost of the run's sessions, live from the synced session data. The run's sessions are the
child sessions of the run's root session, the one definition that the TUI and the `summary` actor share (AD-18). Cost
is not in `status.json` (AD-13). Tokens use `Locale.number` ("61.0K", "1.4M"). Cost uses the USD money format ("$2.31").

| Surface | Shows | Rules |
|---|---|---|
| Prompt footer | "run 1.4M tokens · $2.31" | In a `/task` root session only. When the root also has its own assistant message with output tokens, today's "12.3K (5%) · $0.02" comes first, then " · run 1.4M tokens · $2.31". |
| Sidebar Context panel | "1,402,331 tokens in the run", "$2.31 spent in the run" | In a `/task` root session only. The root's own three lines show only when the root has an assistant message with output tokens above 0, the panel's existing filter. The closing summary has none, so the zero lines never come back at the end of the run. Design 1 relies on this panel, which sits under the Ledger. |
| HUD panel | "elapsed 24m 10s · 1.4M tokens · $2.31" | The tokens drop first when the line does not fit. |
| Full-screen header | "1.4M tokens · $2.31" before the trusted bar, in `{theme.textMuted}` | The tokens drop first, then the cost, before the title is cut. |
| Dock strip | "$2.31" segment after the stopped count, in `{theme.textMuted}` | Dropped before the task chips. |
| Ticker dialog | "◆ In the Flow tasks · $2.31" | |
| Closing summary | The counts line | Summed from the session store when the run ends (D24). |

- The run part shows "$0.00" on purpose for a free model that spent tokens. The footer's own zero rule is unchanged.
- Before any harness session reports tokens, the run usage is hidden. Each surface shows what it shows today.
- A `/task` root session is a session that owns harness sessions, the existing `owns` check of the task-ui.

## Design placement

What each design adds for this goal.

| Design | Collapsed | Expanded |
|---|---|---|
| 1 Ledger | Header with the In the Flow mark and run state; run title on its own line (`{theme.textMuted}`, cut); bar, trusted count, stopped count; run warning line; outside wait line; tree; run reason line | Sidebar, 38 cells, scrolls with the sidebar: tree, Peek, shared region |
| 2 Dock | In the Flow mark; run state; "! spec"; "/task trust T9"; bar, trusted count, stopped count; "$2.31"; task chips; selected task | Above the strip, at most half the terminal height. From 110 cells: the Peek on the left (half the width, at most 72 cells) and the shared region on the right. Under 110 cells: the Peek, then the shared region |
| 3 Board | Shortcut bar only | Header (In the Flow mark, design, run title · run state, run usage, bar, stopped count); run warning line; outside wait line; run reason line; six columns; on the right (56 cells): the Peek, then the shared region. When the terminal is under 149 cells, the right pane moves below the board: the Peek and the region side by side from 110 cells, else stacked |
| 4 Matrix | Shortcut bar only | Header; run warning line; outside wait line; grid with the `time` column; legend; open obligations of the selected task; shared region; Peek at the bottom, as today |
| 5 Gantt | Shortcut bar only | Header; run warning line; outside wait line; axis; lanes with the duration and state column; legend; shared region; Peek at the bottom, as today |
| 6 HUD | Panel: In the Flow mark and run state; bar, trusted count, stopped count (the bar shrinks by the width of the stopped count); selected task with its duration; elapsed and run usage; run warning line; outside wait line | A float under the panel, 64 cells, at most the terminal height less 3 rows: Peek, shared region |
| 7 Ticker | Shortcut bar parts; toasts; end-of-run notification with the run reason line | Dialog: the task list on the left (30 cells); on the right (72 cells) the Peek, then the shared region |

Ledger collapsed, during the release-notes run before `/task trust T9`:

```
◆ In the Flow run: running
Release notes from conventional comm…
▰▰▰▱▱▱ 3/6 trusted
waiting on T9 (outside) — run
/task trust T9
○ T1                         waiting
├ ✓ T1.1                     trusted
├ ✓ T1.2                     trusted
├ ✓ T1.3         trusted · attempt 2
├ ◐ T1.4        building · attempt 2
└ ○ T1.5                     waiting
```

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| No status file | Every design | Nothing shows, as today. The full-screen route says "No task run in this directory." |
| Half-written status | Every design | The last good status stays, as today. |
| Run started, no tokens yet | Footer, sidebar, task-ui | Run usage hidden. The diamond animates. Durations count once a task starts. |
| Running | Every design | The diamond animates. Live durations count. The stopped count shows when above 0. |
| Waiting on an outside task | Every design | The outside wait line in `{theme.warning}`, collapsed and expanded, and the shortcut bar part. The run does not end. The job keeps its heartbeat, so `liveness` stays `live` and the diamond keeps animating. |
| Waiting on an external task | Board card, Peek | "waiting on T1.1 (not in this run)" in `{theme.textMuted}`, with no trust command (AD-15). It shows only between `run.started` and the external trust record. |
| A task died while others work | Every design | The task moves to STOPPED with its `reason`. Its dependants move to STOPPED as blocked in the same refresh. Independent tasks keep working (D3). The stopped count shows in every trusted count. |
| Spec stopped validating | Every design, toast | Run warning: one line collapsed, the `run.warning` lines in the shared region. The run keeps working. The next valid reload clears it. |
| Run stands still (`liveness` is `still`) | Every design | The diamond is static. Durations with no `endedAt` stop at `run.aliveAt`. Tab, `esc` twice and the watch keys leave the run alone, because the run is not live. |
| Run ended: done | Every design, transcript | The diamond is static. Durations are fixed. The closing summary appears in the transcript. A scenario still tagged `waiting` reads "not run", and the summary lists it under **Not run**. Its "not run" reason lines show in the run reason line, in `{theme.warning}`. |
| Run ended by a stop (`run.cancelled`, or `run.ended` such as the run wall clock) | Every design, transcript | As done, plus the run reason line in `{theme.error}` (the stop's reason) and the STOPPED list. The summary's outcome line reads "— <label of `run.state`>: <first line of `run.reason`>". |
| Run ended: failed, every task trusted | Every design, transcript | A scenario failed or was rejected (AD-4, owner answer). The run reason line reads "acceptance not proved: S4 rejected". The summary's outcome line reads "— failed: acceptance not proved". |
| Run ended: budget exhausted, failed, needs human (a dead task) | Every design, transcript | As done, plus the run reason line and the STOPPED list. |
| Run cancelled | Every design, transcript | As a stop. Cancelled tasks share STOPPED lines by `reason`. |
| Refused | Transcript, every design | The refusal message; `run: refused` and the `run.reason` lines ([Refusal](#refusal-d10-d13)). |
| A second `/task` while a run is live | Transcript | The busy reply ([Refusal](#refusal-d10-d13)). `status.json` and the task-ui keep the live run. |
| Animations off | Every `Brand` element | Static `◆`. Nothing else in this document animates. |
| No scenarios in the run | SCENARIOS list | "SCENARIOS none in this run". |
| Task ended and never started | Peek | "no builder session: the task did not start". |
| Not a `/task` root session | Footer, sidebar | Unchanged opencode behaviour. |

## Interaction Primitives

| Key or gesture | Action | New |
|---|---|---|
| `ctrl+x o` | Expand or collapse | no |
| `ctrl+x v`, `/task-design` | Switch designs | no |
| `ctrl+x j/k` | Select a task | no |
| `tab`, `shift+tab` | Select a task while `liveness` is `live` | no |
| `ctrl+x w` | Watch | no |
| `esc` twice, in the watch view | Stop the run | no |
| `j`/`down`, `k`/`up`, `v`, `esc`/`q` | Full-screen views: select, next design, collapse | no |
| `pageup`, `pagedown` | Full-screen views and the Ticker dialog: scroll the shared region | yes |
| Mouse wheel on the shared region | Scroll it | yes |
| Click on a STOPPED line | Select its first task | yes |

- Scenario entries are not selectable. A scenario has no Peek.
- `/task trust T9`, named on the outside wait line, is an ordinary command that the user types.

## Accessibility Floor

- **Never colour alone.** Every state has its own glyph, and the expanded views name the state in words. Blocked
  (`⊖`) and waiting (`○`) differ in shape, not only in colour.
- **Motion.** The diamond is the only animation that this goal adds. With `animations_enabled` off, and while the run
  stands still, it is static. It changes shape, not brightness, and it does not flash.
- **Keyboard.** Every surface in this document opens through keys. `ctrl+x j/k` reaches every task that a STOPPED line
  selects. `pageup` and `pagedown` reach every entry of the shared region in a full-screen design or the Ticker dialog.
- **Full text.** A reason that a list cuts shows in full in the Peek heading during the run, and in the closing
  summary after it.
- **Lasting record.** The header, the refusal and the closing summary are transcript messages. They stay in scrollback
  and in the model's context.
- **Contrast.** Colours come only from theme tokens. Each theme file sets its own contrast.
- **Glyph width.** Every glyph is one cell wide and already renders in this TUI, except `⊖` (U+2296), which sits in the
  same Unicode block as `⊘`.

## Responsive & Platform

The sidebar shows automatically above 120 cells (`routes/session/index.tsx`). At 120 cells and below, it opens as an
overlay on demand.

| Element | Narrow behaviour |
|---|---|
| Run header | Wraps at word boundaries in the message panel. The title is never cut. |
| Refusal | Each failure line wraps in the message panel. |
| Closing summary | Markdown wraps. The tasks table has four short columns. |
| Prompt footer usage | Drops the root's own figure first, then the word "tokens" ("run 1.4M · $2.31"), then shows the cost alone. |
| Sidebar Context panel | Fixed 38 cells. Shows with the sidebar. |
| Shortcut bar | Drops parts from the end, as today. The run warning and the outside wait come first. |
| In the Flow mark | One cell for the diamond at every width. |
| Ledger | Fixed 38 cells. The run title is cut with `…`. The outside wait line wraps. |
| Dock | The side-by-side expanded layout needs 110 cells; below that, the blocks stack. The strip drops the selected task, then the cost, before it cuts the task chips. |
| Board | Six columns with a 14-cell floor. Under 149 cells, the right pane moves below the board. Under 91 cells, the six columns no longer fit and the right-most columns are cut, as today; the STOPPED list in the shared region still shows every stopped task. |
| Matrix | The `time` column keeps its 7 cells. The label column cuts first. |
| Gantt | The lane narrows first, down to 10 cells. The right column keeps its 30 cells. |
| HUD | Fixed 44-cell panel and 64-cell float. |
| Ticker dialog | 30 + 72 cells. When the dialog is narrower than 108 cells, the right column narrows first, down to 48 cells. |
| STOPPED list | Each entry cut with `…`. Under 30 cells, the reason goes. |
| SCENARIOS list | One column under 80 cells. The title keeps at least 12 cells. |
| Peek BUILDER heading | Wraps with no line limit. Under 48 cells, the Peek border title is short, as today. |
| Durations | Never cut. The state text next to them is cut first. |
| Run warning | One line, cut with `…`. Each failure line in the shared region is cut on its own. |

## Inspiration & Anti-patterns

- **Lifted from Claude Code:** the spinner glyph that grows, then melts (question 12, D23).
- **Lifted from opencode:** the hint style (key, then a muted label), the `animations_enabled` setting, and the money
  and number formats of the prompt footer.
- **Rejected — a seventh BLOCKED column:** six columns already reach the 14-cell floor at 149 cells with the Peek on
  the right; seven would need 164. STOPPED already means "nothing moves without the user", which is true of a blocked
  task.
- **Rejected — moving the selection to a failed task:** the selection stays the user's. The STOPPED list and the
  stopped count show the failure and move nothing.
- **Rejected — a reason in the collapsed views:** collapsed views keep the glyph (D19). The stopped count is a number,
  not a reason.

## Key Flows

Mark is the harness owner. Flows 1, 2 and 4 run in the demo folder that `task-demo.sh` seeds, inside a 200 × 50 `tmux`
pane (`tmux new-session -x 200 -y 50`), with the TUI's configured model (D25). At that size the sidebar shows and the
Board keeps its right pane. Flow 3 replays the run that Mark saw in `/Users/marknorgate/Projects/eque2/test`. The two
D15 specs do not exist yet, so their titles show as "<H1>".

### Flow 1 — The scenario folder runs a scenario (AC 27)

Mark asked why the scenarios never appeared (question 6). He wants to see one run in the real TUI. Capture: Ledger,
expanded.

1. Mark types `/task task-formats/blend/example-scenarios.spec`.
2. The transcript shows "Implementing spec **<H1>**". The shortcut bar reads "◆ In the Flow Ledger", and the diamond
   grows and melts.
3. The Ledger shows `◐ T1.1 building`. Mark presses `ctrl+x o`. The Peek heading reads "building · attempt 1 · 42s",
   and the duration counts up. The SCENARIOS list reads "○ S1 waiting on T1.1 · <title>".
4. The prompt footer shows "run 38.2K tokens · $0.04" and grows while the builder works.
5. T1.1 turns `✓ trusted`. Its duration stops at "3m 12s". S1 turns `· pending` while the harness runs its `[S1]`
   test and the verifier judges it.
6. **Climax:** S1 turns `✓ trusted`. The diamond stops on a static `◆`. The closing summary appears in the
   transcript: "Spec **<H1>** — done", then "Tasks 1/1 trusted · Scenarios 1/1 trusted · 4m 3s · 61.0K tokens · $0.07",
   then the tasks table. Mark scrolls up once. The header is the run's first message, and the summary is its last.

Failure: the verifier rejects S1. The SCENARIOS list shows "✗ S1 rejected · <title>" with the verdict reason under it.
T1.1 is trusted, so the run ends `failed` with the reason "acceptance not proved: S1 rejected" (AD-4, owner answer).
The summary reads "Spec **<H1>** — failed: acceptance not proved" and lists S1 under **Scenarios that did not pass** with the
full reason.

### Flow 2 — The cascade folder fails on purpose (AC 27)

Mark wants to see D2 and D3 in the real TUI: one task dies, its dependant blocks, and independent work finishes.
Capture: Board, expanded.

1. Mark types `/task task-formats/blend/example-cascade.spec`. The header reads "Implementing spec **<H1>**".
2. He picks Board with `/task-design` and presses `ctrl+x o`. T1.1 and T1.3 are in BUILDING together. T1.2 is in
   WAITING with "waiting on T1.1".
3. T1.1 moves to PROVING. Its gate exits 1. With a one-attempt budget, T1.1 moves to STOPPED: `⊘ T1.1`, "budget
   exhausted", "attempt 1 · 1m 50s", and the gate's reason in `{theme.error}`.
4. In the same refresh, T1.2 leaves WAITING. It sits in STOPPED under T1.1: `⊖ T1.2`, "blocked by T1.1: budget
   exhausted". The header reads "0/3 trusted · 2 stopped".
5. Mark selects T1.1 with `j`. The Peek heading shows the full reason. T1.3 still builds and the diamond still moves,
   so he lets the run go on.
6. **Climax:** T1.3 reaches TRUSTED with "attempt 1 · 4m 2s". The run ends and the diamond stops. Mark presses `esc`.
   The summary reads "Spec **<H1>** — budget exhausted" and "Tasks 1/3 trusted · 1 budget exhausted · 1 blocked". Its
   **Stopped** section lists T1.1 with the gate's reason and T1.2 blocked by T1.1. The tasks table gives T1.3's
   duration, and the counts line gives the run's cost.

Failure: Mark edits a `VERIFY.md` during the run and breaks it. The Board header shows "! spec no longer validates · 1
failure", and a warning toast appears once. The shared region lists the R-line. The run keeps its loaded plan. The
summary says that the spec stopped validating during the run.

Failure (AD-19): while the cascade run is live, Mark types `/task task-formats/blend/example-scenarios.spec`. The
transcript reads "Not started: the run of task-formats/blend/example-cascade.spec is live in this directory (/task
task-formats/blend/example-cascade.spec). One run at a time: wait for it to end, or stop it in its own session with
ctrl+x w, then esc twice." The Board keeps showing the cascade run.

### Flow 3 — The release-notes run that sat stuck (question 13)

The observed run: T1.4 exhausted its budget, and T1.5 and T1 sat in WAITING for ever with no reason. Mark runs the same
spec after this goal.

1. Mark types `/task task-formats/blend/release-notes.spec` and forgets `/task trust T9`. The header reads
   "Implementing spec **Release notes from conventional commits**".
2. On the Ledger, his default design, the collapsed view shows "waiting on T9 (outside) — run /task trust T9" in
   `{theme.warning}` under the counts. The shortcut bar shows the part "/task trust T9 outside wait".
3. Mark types `/task trust T9`. The line and the part go (D4).
4. He picks Board and presses `ctrl+x o`. T1.4 builds three times, and T1.4.c7 is rejected each time. T1.4 moves to
   STOPPED: `⊘`, "budget exhausted", "attempt 3 · 6m 40s", and "T1.4.c7 rejected: the multiline-message test asserts
   only that 'topic change' appears".
5. **Climax:** in the same refresh, T1.5 and T1 leave WAITING. They stand in STOPPED as `⊖`, "blocked by T1.4: budget
   exhausted". Nothing is left in WAITING. The run ends, the diamond stops, and the summary names T1.4's reason and the
   two blocked tasks. Mark knows what to fix: the T1.4.c7 test.

Failure: Mark never trusts T9, and nothing dies. The outside wait line stays on every design. The watch band reads
"Nothing is running. The run is waiting on T9 (outside) — run /task trust T9." The run waits, because one command can
move it.

### Flow 4 — A fault folder is refused in full (D10, D13, D14)

1. Mark types `/task task-formats/blend/example-format-faults.spec`.
2. The transcript reads "Refused task-formats/blend/example-format-faults.spec: 3 failures. No work started.", then
   the R1, R4 and R3 lines, then "Fix each line, then type /task task-formats/blend/example-format-faults.spec again."
3. The Ledger shows `run: refused` and the same three lines in `{theme.error}`.
4. **Climax:** Mark fixes all three faults in one pass, because the first run named every one of them.

Variant (D13): Mark runs the T1.2 folder of `example-outside-run.spec`. The transcript reads "Refused
task-formats/blend/example-outside-run.spec/<T1.2 folder>: 1 failure. No work started.", then "R12 <T1.2 folder, relative
to the spec>: T1.2 is after T1.1, which is outside this run and not trusted", then "Run the whole spec, or a folder
that holds T1.1."
## Own-judgment additions

These go beyond the letter of a decision or an AD, without a conflict. `[CS]` writes a scenario for each one, or cuts
it.

- The outside wait line and the shortcut bar part on every design, for tasks and scenarios (D4 and AD-16 name the
  hint, not its places).
- The "not run" label for a scenario still tagged `waiting` after the run ended.
- The stopped count after every trusted count.
- The Ticker toast with the `reason`; the watch band text with the trust command.
- The shared region as a scroll box, with `pageup` and `pagedown`; the Peek's activity lines shrink first.
- The STOPPED list on the Board too, and the click on a STOPPED line.
- The Board's right pane moving below the board under 149 cells.
- The hour form of the duration format.
- The "did not start" fallbacks in the Peek.
- The run warning toast, and the run warning line in the closing summary.
- The run's duration, the "not run" count, the " · N scenarios not run" outcome suffix, the **Not run** section and
  the wider **Scenarios that did not pass** section in the closing summary; the new Matrix legend.
- The diamond is not bold in either form.
- The prompt footer's narrow drop order.

## Open Questions

One item is open for the architecture owner, and it does not block `[CS]`:

- **The `DISPLAY` allowlist entry.** AD-16 and AD-17 describe `DISPLAY` as "state to glyph and tone". This document
  puts the Gantt block and the Board column field in the same table, so that it stays the only table keyed by state
  names. Widen the AD-17 description to "glyph, tone, Gantt block and Board column".

The questions of the first version have these answers:

1. **A run that stopped moving.** Answered by `run.aliveAt` and the `liveness` region (AD-13, AD-16; prepare-goal
   default of 2026-10-14): the diamond and the live durations stop when no live job owns the run.
2. **Run warning clearing.** Answered by AD-12 and AD-13: the next reload that validates clears `run.warning`.
3. **Gantt phases.** Answered by `tasks[].spans` (AD-5, AD-16): the lane shades each phase again.
4. **Session title.** Deferred (see below).

## Deferred

- **The root session's sidebar title.** Out of scope: D17 names the first message only (prepare-goal decision of
  2026-10-14). opencode's own title stays as it is.

## Assumptions

- The run's tokens are input plus output plus reasoning tokens, summed over every assistant message of the run's
  sessions (AD-18). Cache reads and cache writes are not counted, because the cost already prices them. AD-18 names
  the sum but not the token fields.
- The Gantt block and the Board column field of each state join the display table, so the `DISPLAY` entry of the
  AD-17 allowlist covers them and the task-ui adds no second table keyed by state names (see Open Questions).
- The busy reply reads the live run's spec and path from the directory lease (AD-19), so the command does not read
  `status.json` for it.
