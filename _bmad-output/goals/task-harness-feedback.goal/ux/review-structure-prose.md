# EXPERIENCE.md review — structure and prose lenses

Read: this document exists to help downstream agents (the architecture run, the spec writer, the builders) extract the
exact behaviour of each `/task` TUI surface after the task-harness-feedback goal.

- Structure model: Reference/Database (random access by surface; one schema for each component).
- Reader type: llm (the request names downstream agents).
- Style guide: the goal's house register (`../decisions.md`: one topic for each sentence, active voice, one word for
  one meaning, simple tenses, no noun cluster over three words). It overrides the configured Microsoft guide.
- Word counts: 7,093 words in total (word_metrics.py).

Each item gives the pass, the disposition, the place and the quoted text, then the fix.

## Findings

- **[high]** prose — The watch band text uses "waits on", which Voice and Tone forbids. The Do/Don't table lists
  "waits on T9" as a Don't. (Component Patterns / Watch band idle text, and Key Flows / Flow 3 Alternate: "Nothing is
  running. The run waits on T9 (outside) — run /task trust T9.") *Fix:* "Nothing is running. Waiting on T9 (outside) —
  run /task trust T9." in both places.

- **[high]** prose — "cause" has two meanings: a group of tasks in the STOPPED order, and the "blocked by …" sentence
  (the status field "blocked cause"; D16 calls it the "upstream cause"). The ordering rules that builders implement use
  both meanings. (State vocabulary / STOPPED list cells "yes, as a cause", "yes", "yes, after the causes", "yes, last";
  STOPPED list / "Order: causes first (failed, budget exhausted, needs human, stalled) in tree order, then blocked
  tasks, then cancelled tasks."; Board card / "STOPPED column order: causes, then blocked tasks, then the rest, as in
  the STOPPED list. A blocked card sits after the card of the task that caused it, so the column reads cause first.";
  Component Patterns / Ticker toast "Causes come before blocked tasks.") *Fix:* keep "cause" for the "blocked by …"
  sentence only. State vocabulary cells: failed, budget exhausted, needs human and stalled → "yes, group 1"; blocked →
  "yes, group 2"; cancelled → "yes, group 3". STOPPED list: "Order: group 1 (failed, budget exhausted, needs human,
  stalled) in tree order, then group 2 (blocked), then group 3 (cancelled)." Board card: "STOPPED column order: the
  STOPPED list order. A blocked card sits after the card of the task that its cause names." Ticker toast: "A task
  comes before the tasks that it blocks." This also fixes the stalled cell, which reads "yes" although the Order
  bullet puts stalled with the causes.

- **[medium]** prose — The subtree refusal text uses "depends on", which Voice and Tone forbids. (Refusal / bullet 2,
  and Flow 4 / Variant: "1 task depends on a task outside this run that is not trusted.") *Fix:* "Refused <path>: 1
  task is after a task outside this run that is not trusted. No work started." This matches the pair line "T1.2 is
  after T1.1" and the D13 wording. Consider: narrow the Voice rule to waits if "depends on" must stay?

- **[medium]** structure CUT (−54 words) — The Run warning "Placement:" bullet repeats the Design placement table, the
  Shortcut bar section and the Responsive table. (Run warning / "Placement: the Ledger under its header lines; … so a
  narrow bar keeps it.") *Fix:* cut the bullet. In Shortcut bar, replace "Designs 3–5 add "k/n trusted" and the stopped
  count last." with "Designs 3–5 put the "! spec" part first, and add "k/n trusted" and the stopped count last."

- **[medium]** prose — "mark" names the person (Mark) and the component. "The mark" and "the diamond" also name the
  same glyph. *Fix:* use "In the Flow mark" for the component, "the diamond" for the animated glyph, and "Mark" for the
  person only. Information Architecture / Shortcut bar: "Mark, design name, status parts, keys" → "In the Flow mark,
  design name, status parts, keys". Design placement: Dock "Mark; run state;" → "In the Flow mark; run state;"; Ledger
  "Header with the mark;" → "Header with the In the Flow mark;"; HUD "Panel: mark and run state;" → "Panel: In the Flow
  mark and run state;". State Patterns: "the mark animates" → "the diamond animates" (2 rows); "the mark keeps
  animating" → "the diamond keeps animating"; "The mark is static" → "The diamond is static"; "The mark follows D23" →
  "The diamond follows D23". In the Flow mark: "the text after the mark never moves" → "the text after the diamond
  never moves".

- **[medium]** prose — "columns" means terminal width and also Board and list columns. Component Patterns sets
  terminal cells as the width unit. (Information Architecture / "Sidebar (auto above 120 columns)"; Responsive &
  Platform / "above 120 columns" and "at 120 columns and below"; Inspiration / "at 149 columns") *Fix:* "120 cells",
  "120 cells and below", "149 cells".

- **[medium]** prose — The flows name raw colours. Foundation says that this document cites colours as theme tokens.
  (Flow 2 step 3 "in red"; Flow 3 step 2 "in yellow,"; Flow 3 Alternate "the yellow trust line"; Flow 4 step 3 "in
  red") *Fix:* "in `{theme.error}`"; "in `{theme.warning}`,"; "the `{theme.warning}` trust line"; "in
  `{theme.error}`".

- **[medium]** prose — The Full text bullet contradicts itself: "in full" and "(3 lines)". (Accessibility Floor /
  "Anything a list cuts is in full in the Peek heading (3 lines), on the Board card (3 lines), or in the closing
  summary (never cut).") *Fix:* "**Full text.** Anything a list cuts shows in up to 3 lines in the Peek heading and on
  the Board card, and in full in the closing summary."

- **[medium]** structure CONDENSE (−32 words) — "Scenarios use the same table" is not accurate: pending and rejected
  are not in the table. The `⊖` reasoning repeats Accessibility Floor. (State vocabulary / "Scenarios use the same
  table: … so a blocked unit never reads as a waiting one.") *Fix:* "Scenario glyphs: waiting `○`, pending `·` (the
  harness runs or judges it), trusted `✓`, rejected `✗`, failed `✗`, blocked `⊖`." Keep the code point in Accessibility
  Floor / Glyph width: "except `⊖` (U+2296), which sits in the same block as `⊘`."

- **[medium]** structure CONDENSE (−8 words) — The Durations placement table has an Expanded column that reads "yes" in
  every row. Its Collapsed column uses "none" and "—" for the same value. (Durations / design table) *Fix:* cut the
  Expanded column. Set Collapsed to "no" in every row except "6 HUD", which keeps "yes".

- **[medium]** prose — Flow 2 step 6 puts six topics in one 60-word sentence. It also calls the summary's **Stopped**
  section "STOPPED". (Flow 2 / step 6) *Fix:* "**Climax:** T1.3 reaches TRUSTED with "attempt 1 · 4m 2s". The run ends
  and the diamond stops. Mark presses `esc`. The summary reads "Spec **<H1>** — budget exhausted" and "1/3 tasks
  trusted · 1 budget exhausted · 1 blocked". Its **Stopped** section lists T1.1 with the gate's reason and T1.2
  blocked by T1.1. The tasks table gives T1.3's duration, and the counts line gives the run's cost."

- **[medium]** prose — Line 1 shows a blocked task's cause, and then lines 2–3 show "the reason or cause" again for a
  blocked task. (Peek BUILDER heading / "Lines 2–3: the reason or cause, for a failed, exhausted, needs-human, stalled
  or blocked task.") *Fix:* Consider: "Lines 2–3: the reason of a failed, exhausted, needs-human or stalled task, or
  the wrapped end of a blocked cause."?

- **[medium]** prose — Three terms name the display name of a state: "status words", "state word" and "state label".
  (Voice and Tone / "Use the status words for states, with `_` shown as a space"; SCENARIOS list / "the state word,
  " · "" and "the glyph, the id and the state word are never cut") *Fix:* "Use the state labels, with `_` shown as a
  space"; "the state label, " · ""; "the glyph, the id and the state label are never cut".

- **[low]** structure CONDENSE (−130 words) — Twelve of the fifteen Component Patterns rows only say "See
  [subsection]". Their "Where" values repeat the first line of each subsection. The Gantt lane row repeats Durations /
  Gantt lane. (Component Patterns / table) *Fix:* Consider: keep only the Stopped count, Ticker toast and Watch band
  idle text rows, and let the subsection headings index the rest? Trade-off: extractors lose a one-table list of
  components.

- **[low]** structure CUT (−16 words) — The Design placement intro defines "Shared sections" again, and the table never
  uses the term. (Design placement / ""Shared sections" are the run warning list, the STOPPED list, the Peek and the
  SCENARIOS list.") *Fix:* cut the sentence. Keep "What each design adds for this goal."

- **[low]** structure CUT (−10 words) — An assumption repeats a rule. (Assumptions / "The live durations use the
  task-ui's existing once-a-second clock."; Durations / Live states the same rule) *Fix:* cut the Assumptions bullet.

- **[low]** structure CONDENSE (−12 words) — The Tasks bullet repeats an assumption. (Closing summary / "The table has
  no title column, so it stays narrow; the status carries no task title.") *Fix:* "The table has no title column."

- **[low]** prose — The document never defines "dead" or "died". (Component Patterns / Ticker toast "A task that turns
  blocked or dead"; State Patterns / "A task died; others still work", "The dead task") *Fix:* "A task that turns
  blocked or dead (failed, budget exhausted or needs human)". This is the D3 set.

- **[low]** prose — Compound tense. (In the Flow mark / "when the run's tags say it has ended"; Durations / Gantt lane
  "once the task has ended") *Fix:* "when the run's tags say it ended"; "once the task ends".

- **[low]** prose — "hint" and "part" name the same thing, and the sentence is passive. (Shortcut bar / "The room the
  hint freed is not reused.") *Fix:* "No other part takes the freed room."

- **[low]** prose — Tautology. (STOPPED list / "Each line is one line, cut with `…`.") *Fix:* "Each entry takes one
  line, cut with `…`."

- **[low]** prose — "the developer" appears once. The rest of the document says "the user". (Inspiration &
  Anti-patterns / "nothing moves without the developer") *Fix:* "nothing moves without the user".

- **[low]** prose — Two verbs for one motion. (Flow 1 step 2 "the diamond grows and melts"; Inspiration "grows, then
  shrinks") *Fix:* "the diamond grows and shrinks".

- **[low]** prose — Idiom. (Design placement / Height "the Peek's activity lines give way first"; Open Questions 3
  "after the Peek's activity lines give way") *Fix:* "the Peek's activity lines shrink first"; "after the Peek's
  activity lines shrink".

- **[low]** prose — The watch band has three names, and one row name is a four-noun cluster. "in work" is an idiom.
  (Information Architecture / "Watch view band"; Component Patterns / "Watch band idle text", "Watch view with nothing
  in work") *Fix:* "Watch band"; "Idle text of the watch band"; "Watch band with nothing running".

- **[low]** prose — Four labels for one kind of flow beat. The bmad-ux template uses "Failure:". (Flow 2 "Edge:";
  Flow 3 "Alternate:") *Fix:* "Failure:" for both. Keep Flow 4 "Variant (D13):".

- **[low]** structure CONDENSE — Six key bindings sit in one 45-word sentence, and the key notation differs from the
  Shortcut bar ("Tab and Shift+Tab" against `tab`). (Interaction Primitives / bullet 1) *Fix:* replace the bullet with
  this table:

  | Key | Action (as today) |
  |---|---|
  | `ctrl+x o` | Expand or collapse |
  | `ctrl+x v`, `/task-design` | Switch designs |
  | `ctrl+x j/k` | Select a task |
  | `tab`, `shift+tab` | Select a task while the run is live |
  | `ctrl+x w` | Watch |
  | `esc` twice, in the watch view | Stop the run |

- **[low]** prose — Noun cluster over three words. (Durations / Run not live "stops counting at the run's last change
  time"; State Patterns / "Durations with no end stop at the last change time.") *Fix:* "stops counting at the time of
  the run's last change"; "Durations with no end stop at the time of the last change."

- **[low]** prose — A bare token ends the Format bullet, so an extractor cannot tell what it applies to. (Durations /
  Format "… where durations form a column. `{theme.textMuted}`.") *Fix:* "… where durations form a column. Colour
  `{theme.textMuted}`."

- **[low]** prose — Unclear scope. (Voice and Tone / "Other `/task` replies keep their text in this goal.") *Fix:* "This
  goal does not change other `/task` replies."

## Summary

- 30 findings: 2 high, 11 medium, 17 low. Overlap: findings 2 and 13 both touch the state vocabulary, and findings 5
  and 11 both use "the diamond".
- Estimated reduction if the author accepts all structure findings: about 262 words, 3.7% of 7,093. There is no
  length target.
- Comprehension trade-off: only the Component Patterns cut (−130 words) removes something useful, the one-table index
  of components. The Information Architecture table still lists every surface.
