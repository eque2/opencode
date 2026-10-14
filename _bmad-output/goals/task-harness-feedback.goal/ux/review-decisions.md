# Review — EXPERIENCE.md against decisions and acceptance criteria

Reviewer: adversarial decision-conformance review, 2026-10-14.
Under review: `ux/EXPERIENCE.md` (status: final).
Binding: `decisions.md` D1–D27, `ACs.md` AC 1–29, `task-questions.md`, `plan.md`.
AC numbering: the order of the checklist in `ACs.md` (AC 18 = D16 … AC 26 = D24, AC 27 = D25).

## Overall verdict

The document conforms to every binding decision it fills in. It contradicts no decision outright. Its choices for
D16 (STOPPED column), D19, D20 and D21 sit inside what the decisions hand to `bmad-ux`, and nearly every claim about
today's code is correct. It is not ready to drive `[CS]` as written: one deferred open question (height overflow)
leaves AC 22 failing on a release-notes-scale run. Six medium gaps also need a fix first: the run-duration source,
the "run not live" duration cap, the sidebar rule after the D18 summary, the Board at 80 columns, the tmux pane size
for AC 27, and status data that D8 does not list.

## Per-decision table

| D | Binding clause (short) | Doc location | Verdict |
|---|---|---|---|
| D2 | "blocked … history entry that names the upstream cause ('blocked by T1.4: budget exhausted')" | State vocabulary; Board card; STOPPED list | conforms: the cause text matches D2 and comes from the status blocked cause, not the history |
| D3 | "the run ends only when every region is final; independent work finishes" | State Patterns "A task died; others still work"; Flow 2 | conforms: the stopped count is an own-judgment addition (see L1) |
| D4 | "the board says 'waiting on T9 (outside) — run /task trust T9'" | Board card line 2; State Patterns; Flow 3 | conforms (exact wording). The watch band addition breaks the doc's own voice rule (L2) |
| D8 | "status.json is a projection … state, tags, blocked cause, start and end times" | Foundation "Data" | conforms (fields named by meaning). Leaves a gap: the doc needs a wait cause, run tags, run warning and run duration that D8 does not list, and the cited spine does not exist yet (M6) |
| D10 | "lists every failure … one line each as `R<n> <path>: <message>`, in the session message and in run.reason" | Refusal (D10, D13); Flow 4 | conforms. Adds a count line. Gap for refusals that have no rule number (L9) |
| D12 | "the run keeps the plan it loaded … the TUI shows them as a run warning" | Run warning (D12) | conforms. Adds a toast (non-conflicting) |
| D13 | "refused at the start … names both tasks … names left-out scenarios in its start message" | Refusal; Run header "Left out:" line; Flow 4 variant | conforms |
| D16 | "classifies units only from the status tags … Board shows blocked tasks with their upstream cause; bmad-ux sets the column" | Foundation "Classification"; State vocabulary; Board card | conforms (STOPPED column, rationale checked). Leaves a gap for an `active`-tagged task in a state outside the three working columns (L5) |
| D17 | "'Implementing spec' muted, title bold, from a structured field … fallback spec id … run gains title" | Run header (D17) | conforms. Adds the run title to the Ledger and the full-screen header (L1) |
| D18 | "one assistant-role markdown message … outcome; failed/exhausted/blocked with reason or cause; rejected scenarios; each task's duration; run's cost" | Closing summary (D18) | conforms. Adds a run duration with no defined source (M1) |
| D19 | "reason or upstream cause in every design's expanded view and in Peek's BUILDER heading … collapsed views keep the glyph" | STOPPED list; Board card; Peek BUILDER heading | conforms in layout. Leaves a gap: the Board STOPPED column is clipped below about 91 columns, and the Board has no STOPPED list (M4) |
| D20 | "every design's expanded view lists the run's scenarios with glyph, id, title and state, and a rejected scenario's reason" | SCENARIOS list; Design placement "Height" | leaves a gap: the lists are clipped when the view is taller than the terminal (Open Question 3), so "every scenario" fails (H1) |
| D21 | "live duration while it runs … final once it ends, from the start and end times … the TUI derives nothing" | Durations (D21) | conforms in its positions. One addition ("Run not live" cap) conflicts with "derives nothing" (M2). The run elapsed still comes from the history (M1) |
| D22 | "delete the `{ key: "/task-design", label: "switch" }` entry" | Shortcut bar (D22) | conforms. "The freed room is not reused" conflicts with the new parts (L1) |
| D23 | "frames `· ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩` … ~120 ms … opentui-spinner element … static when the tags say ended or animations off … plain-text uses static" | In the Flow mark (D23) | conforms. "Bold" frames and "each element owns its own timer" are inexact (L4) |
| D24 | "prompt footer, sidebar and task-ui show summed tokens and cost of the run's harness sessions, live … the D18 summary sums the same" | Run usage (D24) | conforms in intent. The sidebar rule shows the zero lines again after the D18 summary, and the rule is not limited to `/task` roots (M3) |

## Acceptance-criteria walk (AC 18–27)

| AC | A builder following the doc passes? | Note |
|---|---|---|
| 18 (D16) | yes | The blocked card in STOPPED shows the cause. See L5 for the `active`-tag gap |
| 19 (D17) | yes | |
| 20 (D18) | yes | The run-duration source is undefined (M1), but the AC does not require it |
| 21 (D19) | at risk | Fails on the Board below about 91 columns (M4) |
| 22 (D20) | fails at normal sizes | The Board puts SCENARIOS under the columns. The other views keep today's clipping (H1) |
| 23 (D21) | yes, with a risk | The "Run not live" cap freezes live durations whenever the live check is false (M2) |
| 24 (D22) | yes | |
| 25 (D23) | yes | "While the run is active" is followed. The stopped-server case is correctly left to Open Question 1 |
| 26 (D24) | at risk | The sidebar shows "$0.00 spent" again after the summary (M3). Design 1 shows the cost only through the Context panel (L12) |
| 27 (D25) | at risk | No tmux pane size is given. At 80×24 the sidebar Ledger and the Board do not show as the flows describe (M5) |

## Fact check of claims about today's code

Correct: the sidebar is 42 cells with 38 inner (`routes/session/sidebar.tsx:31-36`, `designs/1-ledger.tsx:7-8`). The
sidebar shows automatically above 120 columns and is an overlay below that (`routes/session/index.tsx:316-321`,
`1522-1535`). HUD is 44/64 (`designs/6-hud.tsx:9-10`). Ticker is 30/72 in the xlarge dialog (`designs/7-ticker.tsx:8-9`,
`98`). The Board floor is 14 cells (`designs/3-board.tsx:21`) and PEEK_RIGHT is 56 (`designs/screen.tsx:17`). The
149-column claim holds: body = W − 2 − 57 = 90, and 6×14 + 5 gaps = 89. Gantt LABEL is 11 and RIGHT 30, with a 10-cell
lane floor (`designs/5-gantt.tsx:7-8`, `47`). Matrix LABEL is 12 and CELL 4 (`designs/4-matrix.tsx:7-8`).
`Locale.number` gives "61.0K"/"1.4M" (`util/locale.ts:46-53`). The USD money format is at
`component/prompt/index.tsx:99-102` and `feature-plugins/sidebar/context.tsx:9-12`. The footer reads "12.3K (5%) ·
$0.02" (`component/prompt/index.tsx:324-325`, `1774`). Every glyph and tone in the State vocabulary matches
`store.ts:93-149`. The switch part is at `ui.tsx:136`, and the design-7 and design-3–5 part order is at `ui.tsx:197`.
Toasts are capped at three for each change with the static MARK title (`designs/7-ticker.tsx:56-62`). The Peek title
is plain text with the 48-cell rule (`peek.tsx:153-154`). The BUILDER heading pads to 9 cells (`peek.tsx:225`). The
fallback reads "no builder session yet" (`peek.tsx:173`). There are 7 `Brand` sites. The D23 citation
`ui/spinner.ts:316-321` is right. `component/spinner.tsx:17-19` uses `<spinner>` and `animations_enabled`. The clock
runs once a second (`index.tsx:72-84`). The live window is 5 minutes (`store.ts:81`). The user-message panel uses the
agent-colour left border and `backgroundPanel` (`routes/session/index.tsx:1581-1609`). The markdown renderer draws grid
tables (`routes/session/index.tsx:1887-1892`). The spec H1 "Release notes from conventional commits", the T1.2 title
"Compute the next version", 6 tasks and 13 scenarios all match `task-formats/blend/release-notes.spec`.

Inexact or wrong:
- "Each element owns its own timer". opentui-spinner runs every spinner on one shared scheduler with one
  `setInterval` (`packages/opencode/node_modules/opentui-spinner/dist/src-DjeqLSfu.mjs`). The phases still differ,
  because each spinner starts its own `nextDueAt`.
- The frames are "bold `{theme.accent}`". `SpinnerRenderable.renderSelf` calls `drawChar(char, x, y, fg, bg)` and has no
  attribute, so the animated diamond cannot be bold.
- "Design 7 starts with the run warning, the trusted count, the stopped count and the selected task, as today". Today
  design 7 has only the trusted count and the selected task (`ui.tsx:193-197`). The warning and stopped parts are new.
- `elapsed` (`store.ts:254-257`) has no hour form. "1h 4m" is new, and the HUD elapsed and the Gantt axis use
  `elapsed` (L11).
- The prompt footer hides a zero cost (`component/prompt/index.tsx:325`). "A free model shows … '$0.00'" departs from
  the format the doc says it lifts.
- The live check is not only "no change in the last five minutes". It is also false when the root session owns no
  harness sessions (`index.tsx:100-103`).

## Findings

- **[high]** AC 22 ("lists every scenario of the run") fails at normal terminal sizes. The Board puts the SCENARIOS
  list under the columns. A release-notes status at the start (WAITING holds T1, T1.4 and T1.5, and the T1.5 card is
  about 10 rows at a 10-cell inner width) plus 13 scenario rows overflows 40 rows. The Dock, HUD, Matrix, Gantt and
  Ticker views "keep today's clipping". The doc says "The shared lists never drop an entry" but leaves overflow as
  Open Question 3 while its status is `final`. (Design placement "Height"; Board row; Open Questions 3.) *Fix:* give
  the shared-lists region its own scrollbox in every non-sidebar expanded view. Put the Board SCENARIOS list beside
  the columns or in the right pane under the Peek. Close Open Question 3. Name a fixture check, for example the
  release-notes status at 120×40 showing S1–S13 in each design.
- **[medium]** The run duration and the run elapsed time have no status source. The summary counts line shows "24m
  10s", and the HUD keeps "elapsed …". Today both come from the history through `span` (`designs/5-gantt.tsx:15-22`,
  `designs/6-hud.tsx:50`), and so does the Gantt axis. The doc states "The task-ui derives nothing from the history",
  and D8 gives no run start or end time. (Durations "Source"; Closing summary counts line; Run usage HUD row.)
  *Fix:* define the run span as the earliest task start to the latest task end (or now) from the status times. As an
  alternative, ask the spine for run start and end times, and say that `span` stops reading the history.
- **[medium]** The "Run not live" rule caps a live duration at "the run's last change time". This is a TUI-derived
  end time. It conflicts with D21 ("the TUI derives nothing") and with the doc's own Classification bullet ("live or
  fixed duration … comes from the status tags and times"). The live check (`index.tsx:101-110`) is also false whenever
  the root does not own harness sessions. Live durations then freeze in another session's sidebar while the run
  works, which puts AC 23 at risk. (Durations "Run not live"; State Patterns "Run not live".) *Fix:* drop the cap so
  durations read only the status times, as the mark does under D23. As an alternative, move the cap to Open
  Questions as a request for an engine-side stop fact.
- **[medium]** The sidebar rule breaks after the D18 summary. The summary is an assistant message in the root, so
  under "the root's own three lines show only when the root has its own assistant message" the "0 tokens · 0% used ·
  $0.00 spent" lines come back at run end. That puts AC 26 at risk. The rule is also not limited to `/task` root
  sessions, which changes every opencode session. It also conflicts with "Before the first harness session reports
  tokens … each surface shows what it shows today". (Run usage, Sidebar Context panel row.) *Fix:* in a `/task` root
  session only, show the root's own lines only when it has an assistant message with output tokens above 0. This is
  the existing filter at `feature-plugins/sidebar/context.tsx:21`. Hide them otherwise, also before the run reports
  tokens.
- **[medium]** The Board fails AC 21 below about 91 columns. Six 14-cell columns and 5 gaps need 89 cells plus 2 of
  padding. The STOPPED column is rightmost, so it is clipped first, and the doc excludes the Board from the shared
  STOPPED list. At 80 columns no blocked cause or reason shows on the Board except the selected task's Peek heading.
  (STOPPED list "every expanded view except Board"; Responsive "Board".) *Fix:* when the Board body is narrower than
  89 cells, show the shared STOPPED list under the columns, or let the column row scroll sideways.
- **[medium]** The Key Flows run "inside `tmux`" but give no pane size. tmux starts at 80×24 by default. There the
  sidebar (which needs more than 120 columns) and the Ledger do not show, and the Board with the Peek on the right
  (which needs 149) does not match Flows 1–3. The AC 27 captures can then miss the scenario row, the durations or the
  blocked card. (Key Flows intro.) *Fix:* state the pane size, for example `tmux new-session -x 200 -y 50`, and
  say which design each capture uses.
- **[medium]** The doc depends on status data that D8 does not list. It needs a wait cause (plain and outside, for
  "waiting on T1.3, T1.4" and the D4 trust line), run tags (for the mark), the run warning failures, and a run
  duration. D8 removes the `waitingOn` derivation from the plan. The cited `../architecture/ARCHITECTURE-SPINE.md` does
  not exist yet; `architecture/` holds only `.memlog.md`. (Foundation "Data"; frontmatter sources.) *Fix:* add a
  short "Status data this document needs" hand-off list, by meaning, and re-check it against the spine before `[CS]`.
- **[low]** Scope: these additions have no AC. A builder must build them, but no scenario will check them. They are
  the stopped count, the Ticker toast cause text, the watch-band trust text, the STOPPED-line click target, the run
  title in the Ledger and the full-screen header, the Board Peek moving below under 90 cells, the height give-way
  rule, the footer narrow-drop order, the hour duration format, and the blocked-task Peek fallbacks. "The room the
  hint freed is not reused" also conflicts with the new "! spec" and stopped-count parts. (Component Patterns; Shortcut
  bar; Responsive.) *Fix:* list them as own-judgment additions so that `[CS]` writes a scenario for each, or cut them.
- **[low]** The voice rule says "Use 'waiting on' for every wait. Do not use 'waits on'". The watch-band text is
  "The run waits on T9 (outside) — run /task trust T9." (Component Patterns "Watch band idle text"; Flow 3 Alternate.)
  *Fix:* "Nothing is running. The run is waiting on T9 (outside) — run /task trust T9."
- **[low]** The mock facts are invented or inconsistent. The summary "4/6 tasks trusted · 1 budget exhausted · 2
  blocked" counts 7 of 6 tasks; the observed run is 3/6. The SCENARIOS mock "S1 waiting on T1.4, T1.5" is wrong: S1
  needs T1.1–T1.4 (`acceptance/S1.md`). "S3 … Empty range prints a notice" is invented: the real S3 is "The next
  version follows the most significant change" (`acceptance/S3.md`). (Closing summary mock; SCENARIOS list mock.)
  *Fix:* use the real titles or `<title>` placeholders, and make the counts add up.
- **[low]** The spinner element cannot draw bold (`drawChar` takes no attribute). Each `Brand` sits inside a `<text>`
  today, where a spinner renderable cannot go. The timer sentence is inexact (one shared scheduler). (In the Flow
  mark.) *Fix:* say the animated frames are plain accent, and accept the weight change against the static bold `◆`,
  or use static non-bold too. Say each Brand site becomes a row of the spinner and a text. Restate the sentence as
  "the spinner element runs the frames; the task-ui adds no timer".
- **[low]** The Board rule ("an `active` tag goes to BUILDING, PROVING or VERIFYING by its state") does not place an
  `active`-tagged task in another state, for example `stalled` if the spine tags it active. (State vocabulary, last
  paragraph.) *Fix:* add "any other state goes to STOPPED, whatever its tags".
- **[low]** The Accessibility "Full text" floor is false. The Peek heading cuts at 3 lines with `…`, so during the run
  a long reason is nowhere in full, which weakens D19's "the user needs it during the run". (Accessibility Floor; Peek
  BUILDER heading.) *Fix:* let the Peek heading wrap with no line cap, or reword the floor to say that the full text
  is only in the closing summary.
- **[low]** For a blocked task the Peek heading puts the cause on line 1 and again in lines 2–3, which is ambiguous.
  (Peek BUILDER heading.) *Fix:* say line 1 carries the cause and lines 2–3 only continue it when it wraps.
- **[low]** The widths do not fit. The HUD trusted line is the bar (inner − 13 = 27) plus " 3/6 trusted" = 39 of 40
  cells, so "· 2 stopped" does not fit. The Ledger second line (title + 6-cell bar + trusted + stopped) leaves about
  5 of 38 cells for the title. The Ticker's fixed 30 + 72 cells overflow a dialog narrower than 108 cells.
  (Design placement; Responsive.) *Fix:* shorten the HUD bar by the stopped part's width. Give the Ledger run title
  its own line. Say what the Ticker dialog drops under 108 cells.
- **[low]** The Matrix legend (`designs/4-matrix.tsx:81`) and the Gantt legend (`designs/5-gantt.tsx:85`) need `⊖
  blocked`. The Gantt legend must drop the phase blocks. The glyph of a live span (before `█`) is not given. (Gantt
  lane.) *Fix:* give both legends and the live-span glyph.
- **[low]** The refusal shape covers only R-rule failures. The git-readiness and branch-mismatch refusals
  (`core/command.ts:185`, `196-200`) have no R-number. (Refusal.) *Fix:* say those read "Refused <path>: <message>. No
  work started."
- **[low]** The new "1h 4m" form differs from `elapsed` (`store.ts:254-257`), which the HUD and the Gantt axis use.
  (Durations "Format".) *Fix:* say that `elapsed` gains the hour form everywhere.
- **[low]** With design 1 the task-ui itself never shows the run cost. It relies on the Context panel under the
  Ledger. (Run usage table.) *Fix:* state that the Context panel covers AC 26 for design 1, or add the cost to the
  Ledger header.
- **[low]** A scenario title comes from the `Scenario:` line, which starts with the id (`task-formats/blend/README.md`
  §scenario body). The entry "S1 … · <title>" can print the id twice. (SCENARIOS list.) *Fix:* say the list shows the
  title without its leading id, or leave the rule to the spine and note it.
- **[low]** "A free model shows … '$0.00'" departs from the footer format the doc lifts, which hides a zero cost
  (`component/prompt/index.tsx:325`). (Run usage.) *Fix:* keep "$0.00" for the run part on purpose and say so.

## Owner's voice (questions 2, 6–13)

| Q | Asked | Answered as asked? |
|---|---|---|
| 2 | How does a verification failure appear? | Yes: refusal with every failure, run warning, STOPPED list, Peek heading, summary |
| 6 | Scenarios do not appear in the TUI | Yes in design, but H1 can hide them on the release-notes run the owner named |
| 7 | "Implementing spec **<title>**", with a default | Yes: H1 title, spec-id fallback, muted and bold |
| 8 | The main body explains the outcome, success or failure, like LLM feedback | Yes: the closing summary in the transcript for every end state |
| 9 | Token and cost indicators do not work | Yes: footer, sidebar and task-ui; see M3 |
| 10 | Remove "/task-design switch" | Yes |
| 11 | Per-task timings where they fit, by UX design | Yes: a positions table for every design |
| 12 | The diamond grows and melts | Yes: the D23 frames on every Brand site |
| 13 | A blocked task reports what blocks it | Yes: `⊖` in STOPPED with "blocked by T1.4: budget exhausted"; Flow 3 replays the observed run |
