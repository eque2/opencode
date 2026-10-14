# Spine Pair Review — opencode task-ui

## Overall verdict

Adequate, close to strong. Mechanically the document is clean: every `{theme.x}` resolves to a real `Theme` field,
all 15 internal anchors resolve, the design names and D-numbers are verbatim, every D in scope lands on a specified
surface, and the cell widths it cites (Ledger 38, HUD 44/64, Ticker 30+72, Gantt 30/10, Board 14-cell floor at 149
columns, sidebar at 120) match the code. Three high findings hold it back: the D4 outside wait is invisible in the
default design unless the user selects and expands the right task, the status fields the document depends on are not
stated as a contract for the parallel architecture run, and several rules classify by lifecycle-state lists that the
D9 audit (a CRITICAL AC) forbids.

## 1. Flow coverage — adequate

Checked each Key Flow for a named protagonist (Mark, all four), numbered steps, a bold climax beat, and a failure path
(Flow 1 Failure, Flow 2 Edge, Flow 3 Alternate; Flow 4 is itself the failure path). Checked that each D in scope lands
on a surface a flow visits or a Component Pattern specifies:

| D | Specified in | Visited by |
|---|---|---|
| D10 | Refusal | Flow 4 |
| D12 | Run warning | Flow 2 Edge |
| D13 | Refusal, Run header "Left out" line | Flow 4 Variant (refusal only; the "Left out" line is not visited) |
| D16 | Board card, State vocabulary | Flows 2, 3 |
| D17 | Run header | Flows 1–3 |
| D18 | Closing summary | Flows 1–3 |
| D19 | STOPPED list, Peek BUILDER heading | Flows 2, 3 |
| D20 | SCENARIOS list | Flow 1 |
| D21 | Durations | Flows 1, 2 |
| D22 | Shortcut bar | Flow 1 |
| D23 | In the Flow mark | Flows 1, 2 |
| D24 | Run usage | Flow 1 |

AC 27's two live-check runs are Flows 1 and 2. Between them they show every item AC 27 names: the bold title, the
scenario row, the durations, a non-zero cost, the blocked card and the summary. Question 13's stuck run is Flow 3.

### Findings

- **medium** Every failure flow runs on the Board. Flow 2 picks Board in step 2, and Flow 3 is "On the Board" in step 2
  with no step that picks it. No flow walks a failure, a cascade or an outside wait in the default design (Ledger) or
  in any collapsed view. That is where the gaps in sections 3 and 4 below hide (Key Flows, Flow 2 step 2, Flow 3
  step 2). *Fix:* run Flow 3 on the default Ledger, collapsed first, then expanded, and let its steps show what the
  user sees there.
- **low** The D13 "Left out: S1, S2, S5 — they need tasks outside this run." header line is specified but no flow
  shows it (Run header, line 151; Flow 4 Variant). *Fix:* add one sentence to the Flow 4 Variant, or accept the gap.
- **low** The flows name colours as "red" and "yellow" where the rules name tokens (Flow 2 step 3, Flow 3 step 2 and
  Alternate). Themes differ, so these words can mislead a tester who reads a capture. *Fix:* write
  `{theme.error}` and `{theme.warning}`, or "in the error tone".

## 2. Token completeness — strong

Extracted every `{theme.x}` reference: `text`, `textMuted`, `accent`, `primary`, `success`, `info`, `warning`,
`error`, `backgroundPanel` and `backgroundElement`. All ten are fields of `Theme`
(`packages/tui/src/theme/index.ts:37-92`). No reference is invented.

### Findings

- **low** Some new text has no colour rule: the SCENARIOS state word and its "waiting on" text (lines 299–301), the
  Dock "$2.31" segment (line 398), the full-screen header usage (line 397), and the STOPPED "+N" (line 280). *Fix:*
  add one token to each. The Board card's wait rule (muted for a plain wait, warning for an outside wait) can apply to
  the SCENARIOS waits too.
- **low** The Peek heading line 1 is `{theme.text}` and includes the duration (line 350). Durations says
  `{theme.textMuted}` without a scope (line 363). *Fix:* scope the muted rule to "where durations form a column".
- **low** `{theme.info}` is listed in Foundation (line 31) but no rule uses it. The run header border is "the agent
  colour" (line 142), which is not a `Theme` field. This is acceptable because the border is the existing panel.
  *Fix:* drop `info` from the list, or name where it applies. Add "(existing panel colour)" to the border note.

## 3. Component coverage — adequate

Every component that Component Patterns names has a behavioural rule, and 12 of them have a full subsection. Real
rules, not one-word descriptions. The misses are rules a builder could not implement as written, or could implement
two ways.

### Findings

- **high** Several rules classify by lists of lifecycle states. These are the STOPPED order "causes first (failed,
  budget exhausted, needs human, stalled) … then blocked tasks, then cancelled" (line 277), the Board card's "a failed,
  exhausted, needs-human or stalled task shows its reason" (line 333), and the Peek's "for a failed, exhausted,
  needs-human, stalled or blocked task" (line 352). They contradict the document's own Classification bullet ("Every
  grouping … comes from the status tags and times", lines 38–40). They also put a "list of lifecycle states" into
  `packages/tui/src/task-ui/`, which the D9 audit test fails on (AC 11, CRITICAL). The four tags (`active`, `ended`,
  `blocked`, `waiting`) cannot tell a dead task from a cancelled one. *Fix:* define each rule on tags and fields
  ("a task with a reason shows it"; "`blocked` tag after the rest"). Ask the architecture spine for the one
  classification the tags lack (a dead task vs a cancelled one, for example a `cause` tag). Name the glyph and tone
  maps as the one allowlisted presentation exception.
- **medium** The Peek heading rules conflict for a blocked task and for an outside wait. Line 1 shows the blocked
  cause, and lines 2–3 also show "the reason or cause … for a … blocked task". A builder cannot tell whether the
  cause shows twice or wraps from line 1. Line 1 is `{theme.text}` but lines 2–3 are `{theme.warning}` for the same
  sentence. The State Patterns row puts the outside wait in `{theme.warning}` "in the Peek heading", but line 1 is
  `{theme.text}` (lines 350–354, 432). *Fix:* say that a blocked or waiting task's sentence starts on line 1 and wraps
  onto lines 2–3 in one tone (warning for a blocked cause or an outside wait, muted for a plain wait).
- **medium** The full text of a long reason cannot be read anywhere during a run. The Ledger Peek is 38 cells wide,
  so its heading text is 25 cells (`peek.tsx:139,227`). Lines 2–3 then hold about 50 characters, which cuts the
  document's own 85-character T1.4.c7 example. The Board card also stops at 3 lines. Accessibility Floor says that
  anything cut "is in full in the Peek heading" (line 464), but only the closing summary is never cut, and it appears
  after the run. D19 asks for the reason "during the run, to decide whether to stop it". *Fix:* let the Peek heading
  wrap without a line limit for a stopped task (the Peek's activity lines give way first, as the Height rule already
  allows), and correct the Accessibility claim.
- **medium** The Ledger's second line has no width budget. It holds the run title, a 6-cell bar, "k/n trusted" and
  now "· 2 stopped" in 38 cells, which leaves about 7 cells for the title ("Releas…"). Today's code cuts the end of
  the line, not the title (`1-ledger.tsx:20-25`). The default design therefore loses most of what D17 adds (lines
  154–156, 412). *Fix:* give the run title its own line in the Ledger, or state the budget and the cut order (counts
  kept, title cut).
- **medium** The Gantt lane rule is incomplete. It gives `░` before the start and `█` "once the task has ended", but
  it gives no glyph for the running span, no rule for the cells after a task's end time, and no lane for a blocked
  task that never started. The legend ("░ waiting ▓ building ▒ proving ▞ verifying █ …", `5-gantt.tsx:85`) must
  change, but no new text is given (lines 383–385, 416). *Fix:* specify the running glyph, the post-end cells, the
  blocked lane, and the new legend text.
- **medium** The In the Flow mark rule asks for "bold `{theme.accent}`" frames through `opentui-spinner`. The
  spinner's options are `frames`, `interval`, `autoplay`, `color` and `backgroundColor`, with no bold attribute. It is
  a box-level renderable, but `Brand` sits inside a `<text>` today in five places (`1-ledger.tsx:16`,
  `screen.tsx:29`, `ui.tsx:210`, `7-ticker.tsx:23`, `watch.tsx:167`) (lines 240–243). *Fix:* drop "bold" for the
  animated frame, or accept a non-bold frame. Say that each `Brand` host becomes a row of a spinner and a bold " In
  the Flow" text.
- **medium** The SCENARIOS two-column layout gives no fill order. The mock puts S1 beside S8, then S3 beside S9,
  which skips S2 and fits neither row-major nor column-major order. A rejected entry adds up to 2 reason lines, so the
  two columns have rows of different heights (lines 291–294, 305). *Fix:* state column-major fill (the first ceil(n/2)
  entries on the left), with each column stacking its own entries, and correct the mock.
- **medium** The run reason becomes multi-line (D3: "the reason lists every dead and blocked task"; D10: every
  failure line), but only the refused case says how one-line surfaces show it. The full-screen header cuts the reason
  to one line (`screen.tsx:43-46`). The Ticker's end-of-run notification appends the whole reason
  (`7-ticker.tsx:64-68`). The Ledger shows 3 wrapped lines that repeat the STOPPED list (State Patterns line 436;
  Refusal lines 174–176). *Fix:* define the one-line form for every surface (for example the first line plus "+N
  more"), and say whether the Ledger's run reason stays now that the STOPPED list carries the same text.
- **low** The HUD bar line overflows once the stopped count joins it. Today the bar is `inner − 13` (27 cells) plus
  "3/6 trusted" (39 of 40 cells), and " · 2 stopped" adds 12. The HUD example "▸ ⊘ T1.4 budget exhausted · attempt 3 ·
  6m 40s" is 46 cells against a 40-cell inner width (lines 380, 417; `6-hud.tsx:40`). *Fix:* state that the bar
  shrinks by the stopped count's width, and show the cut form of the example.
- **low** The Matrix legend needs a `⊖ blocked` entry, and the grid cells of a blocked task's obligations have no rule
  (line 415; `4-matrix.tsx:81`). *Fix:* add the legend entry and one sentence on the cells.

## 4. State coverage — adequate

Walked every IA surface against no run, half-written status, starting, running, waiting on an outside task, a task
dead while others run, blocked cascade, spec stops validating, each run end state, refused, run not live, animations
off, no scenarios and narrow terminal. The State Patterns table covers each one at the "every design" level, and the
Responsive table covers narrow widths per element. Two states are thin for particular surfaces.

### Findings

- **high** The outside wait (D4) reaches the user only on the Board card, in the Peek heading and in the watch band
  (State Patterns line 432; Board card lines 325–328; Peek line 351; watch band line 136). In the Ledger (the
  default), Dock, HUD and Ticker, a collapsed view shows "○ T1.5 waiting" and "run: waiting" and nothing more. The
  expanded shared sections (run warning, STOPPED, Peek, SCENARIOS) have no line for waits, and `focus()` selects the
  first task in work, else the first stopped one, else the first task (`store.ts:236-239`), not the waiting one. A
  default-design user therefore sees question 13's symptom again: a run that sits with no report. The one command
  that moves it ("run /task trust T9") is two hidden steps away. *Fix:* add a run-level wait line in
  `{theme.warning}` where the run warning line sits in every collapsed view and in the shortcut bar ("waiting on T9
  (outside) — run /task trust T9"). Also add it to the shared expanded sections, after the run warning list.
- **low** For a refused run, the doc gives the transcript, Ledger and full-screen treatment, but not Dock, HUD or
  Ticker (State Patterns line 438). *Fix:* add them to the row ("run: refused", first failure, cut).
- **low** The column and group of a stalled task are ambiguous. The State vocabulary marks it "yes" (not "as a cause")
  but the STOPPED order puts it among the causes, and it has a live duration. The Board rule sends an `active` tag "by
  its state" to BUILDING, PROVING or VERIFYING, so a stalled task with an `active` tag has no column (lines 105,
  113–114, 277). *Fix:* state stalled's tags and its group once.
- **low** A cancelled task that never started keeps the fallback "no builder session yet", which is false once the run
  has ended. The doc fixes this only for a blocked task (lines 355–356). *Fix:* apply the "did not start" wording to
  every task that has an end state and no start time.

## 5. Visual reference coverage — adequate

No DESIGN.md, mockups, wireframes or imports, as intended. Foundation names the theme sources (the `Theme` type, the
`assets/*.json` files, `context/theme.tsx`), which all exist. Inline text mocks cover the run header, the refusal, the
closing summary, the shortcut bar, the STOPPED list, the SCENARIOS list, the Board card and the Peek heading. The Board
card and Peek mocks are internally aligned (70 and 59 cells; each card's inner width is 18, and "attempt 3 · 6m 40s"
fits exactly).

### Findings

- **low** The new or most-changed layouts have no mock: the collapsed Ledger (title, counts, warning line in 38
  cells), the split Dock expanded view at 110 cells and over, a Gantt row (duration and state column), the Matrix
  `time` column, and the collapsed HUD (lines 412–418). *Fix:* add a mock for the Ledger and for the Dock split.
  These two layouts carry the tightest width rules.

## 6. Bloat & overspecification — adequate

At 615 lines the document is about 4× the examples. Most of that is justified, because it covers seven designs and
four transcript or footer surfaces in a brownfield TUI. The cut candidates are small.

### Findings

- **low** 12 of the 16 Component Patterns rows say only "See [X]" and repeat the subsection headings (lines 122–133).
  *Fix:* keep the four rows that carry rules (Stopped count, Ticker toast, Watch band idle text, Gantt lane), and let
  the subsection headings act as the index.
- **low** Some sentences restate decisions and give no rule to a builder: "never by parsing the text" (line 141, D17),
  "with no model call" (line 180, D18), "The user can ask a follow-up question" (line 222, D18), and the D24 sum
  sentence (line 389). *Fix:* replace each with a D-number reference.
- **low** Width facts appear in two or three places: Gantt 30 and 10 (lines 379, 490), HUD 44 and 64 (lines 417, 491),
  Dock 110 (lines 413, 487). They agree today, but they can drift apart. *Fix:* keep widths in Responsive & Platform
  only.

## 7. Inheritance discipline — adequate

Frontmatter sources resolve except `../architecture/ARCHITECTURE-SPINE.md`. Design names (Ledger, Dock, Board, Matrix,
Gantt, HUD, Ticker), Peek, BUILDER, STOPPED, WAITING, "In the Flow", the D-numbers and the frame list match the
sources and the code. All 15 internal anchor links resolve under GitHub slug rules. The gaps are in the contract that
the document expects other artefacts to honour.

### Findings

- **high** The document depends on status data that no source provides, and it does not state that data as a
  contract for the architecture spine that a parallel run writes now:
  - A **wait cause** that tells plan waits from outside waits (Foundation line 36). D8 removes the `waitingOn`
    derivation and lists no wait cause.
  - A **run start and end time**, for the HUD "elapsed", the Gantt axis and the summary's run duration (lines 186,
    211, 396). Today these come from the history (`5-gantt.tsx:15-22`, `6-hud.tsx:50`), which the doc forbids ("The
    task-ui derives nothing from the history", line 361).
  - The **subtree task id and title**, for the subtree header, the summary outcome line and the full-screen title
    (lines 149, 209–210). This contradicts the Assumption "The status carries no task title" (lines 612–613), because
    the summary is built "from the final status".

  *Fix:* add a "Status fields this document needs" list to Assumptions, with each field's meaning, and hand it to
  the architecture run before it closes the status contract.
- **medium** The run header is "a structured message … drawn from the structured field (D17)", but the doc does not
  say where that field lives (line 141). If the TUI reads `status.json` `run.title`, the next run overwrites it, and
  every older header in scrollback re-renders with the new title. That breaks the "Lasting record" claim (lines
  466–467). *Fix:* say that the header message carries its own title, task id and left-out list. Then it never reads
  the status file.
- **medium** The doc breaks its own voice rule ("Use 'waiting on' for every wait. Do not use 'waits on' or 'depends
  on'", line 72) in two literal strings that a builder will copy: the watch band "The run waits on T9 (outside)"
  (line 136; Flow 3 Alternate, line 575) and the D13 refusal "1 task depends on a task outside this run" (line 171;
  Flow 4, line 586). *Fix:* "Nothing is running. The run is waiting on T9 (outside) — run /task trust T9." and
  "Refused <path>: 1 task is after a task outside this run that is not trusted. No work started."
- **medium** The rule for "summed tokens" (D24) does not say which counts are summed (lines 389–394). The figure that
  the footer shows today is the last message's context fill (input + output + reasoning + cache, plus the window
  percentage, `prompt/index.tsx:310-328`), not a cumulative total. If a builder sums that figure across every message,
  the cache reads are counted again and again, and "1.4M tokens" overstates the spend. *Fix:* define the sum (for
  example input + output + reasoning per assistant message, cache reads excluded or shown apart), or name the
  architecture spine as its owner.
- **low** `../architecture/ARCHITECTURE-SPINE.md` does not exist yet (frontmatter line 9; Foundation line 37). A
  parallel run writes it. *Fix:* none now. Re-check the link when that run lands.

## 8. Shape fit — strong

All required sections are present: Foundation, Information Architecture, Voice and Tone, Component Patterns, State
Patterns, Interaction Primitives, Accessibility Floor and Key Flows. Responsive & Platform is present and triggered
(terminal widths and the sidebar). Inspiration & Anti-patterns is present and earns its place: it records the rejected
seventh column and why. The invented sections earn their place too. State vocabulary is the glyph, tone and column
key. Design placement is the per-design layout that D19–D21 asked UX to set. Open Questions and Assumptions are the
hand-off to architecture.

### Findings

- **low** The IA says that expanded views stack the shared sections in the order "run warning list, STOPPED list,
  Peek, SCENARIOS list" (lines 62–64). Matrix and Gantt stack STOPPED, SCENARIOS, legend, then Peek at the bottom
  (lines 415–416). *Fix:* say that the full-screen designs keep the Peek at the bottom, as today.

## Mechanical notes

- **Counts arithmetic.** The summary example reads "4/6 tasks trusted · 1 budget exhausted · 2 blocked", which totals 7
  tasks out of 6. The observed run had 3 trusted (T1.1–T1.3) (line 186). Use "3/6".
- **Shortcut bar mock.** It shows "3/6 trusted · 2 stopped" (line 255), but in the observed run T1.4, T1.5 and T1
  stop in one refresh ("STOPPED 3", line 269). Either reword it as a different moment or use "· 3 stopped".
- **Refusal path.** The Do/Don't example says "Refused example-format-faults.spec" (line 84), but the rule and the mock
  give the full path "task-formats/blend/example-format-faults.spec" (lines 163, 169). Use one form.
- **Board Peek threshold.** "When the body is under 90 cells, the Peek moves below the board" (lines 414, 488) is
  circular, because the body width depends on where the Peek sits (`screen.tsx:22`). Write "under 149 terminal
  columns". Below 92 columns the six 14-cell columns still overflow, and the doc does not say so.
- **Sidebar.** "Hidden with the sidebar at 120 columns and below" (line 483) conflicts with "below that it opens as an
  overlay on demand" (lines 474–475).
- **Blocked card mock.** The mock omits the "proofs k/n" line that the rule keeps "as today" (line 332). A blocked
  task still has obligations.
- **Verified against code (no action).** Ledger 38 cells (`1-ledger.tsx:8`); HUD 44 and 64 (`6-hud.tsx:9-10`);
  Ticker 30 + 72 (`7-ticker.tsx:8-9`); Gantt right column 1 + 7 + 1 + 21 = 30, and the lane floor of 10
  (`5-gantt.tsx:8,47`); Board 14-cell floor at 149 columns, with the Peek on the right at 56 + 1
  (`screen.tsx:17,22`, `3-board.tsx:21`); Peek short title under 48 cells (`peek.tsx:153`); sidebar above 120 columns
  (`routes/session/index.tsx:316`); the `/task-design switch` part at `ui.tsx:136`; the diamond glyphs are all
  single-width (East Asian Width N or A).
- **Frontmatter.** `name`, `status: final`, `sources` (5 entries, 4 resolve) and `updated: 2026-10-14` are all present.
