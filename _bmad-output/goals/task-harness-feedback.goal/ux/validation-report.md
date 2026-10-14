# Validation Report — task-ui — /task harness feedback (EXPERIENCE.md)

- **DESIGN.md:** none (visual identity is the opencode TUI theme)
- **EXPERIENCE.md:** `_bmad-output/goals/task-harness-feedback.goal/ux/EXPERIENCE.md`
- **Run at:** 2026-10-14T07:19Z

## Overall verdict

First draft: adequate, close to strong. Mechanically clean: every {theme.x} token resolves to a real Theme field, every anchor resolves, the D-numbers and design names are verbatim, and the cell widths match the code. No reviewer found a contradiction of an approved decision.

Four high findings held it back, and all four are fixed in the final file: AC 22 failed on a release-notes-scale run because the scenario list clipped (now one scrollable shared region in every expanded view); the D4 outside wait was invisible outside the Board (now an outside wait line and a shortcut bar part on every design); several rules sorted by lists of lifecycle states, against D16 and the D9 audit (now tags and fields only, with the glyph, tone and column-name maps named as the one allowlisted presentation exception); and the status data the document needs was not stated as a contract (now a 'Status data this document needs' hand-off for the architecture spine).

Verdicts below are the rubric walker's verdicts on the first draft. Every finding lists its disposition in the final file. Four open questions remain; none of them blocks [CS].

## Category verdicts (first draft)

- Flow coverage — adequate
- Token completeness — strong
- Component coverage — adequate
- State coverage — adequate
- Visual reference coverage — adequate
- Bloat & overspecification — adequate
- Inheritance discipline — adequate
- Shape fit — strong

## Findings by severity

### Critical (0)

### High (5)

**State coverage** — Outside wait (D4) hidden outside the Board (§ State Patterns; Board card)
A default-design user saw only '○ T1.5 waiting', which is question 13's symptom again.
Fix: Applied: Outside wait line component on every design, in the shared region, and as a shortcut bar part.

**Inheritance discipline** — Status data not stated as a contract (§ Foundation 'Data')
The doc needed a wait cause with outside ids apart, run start and end times and the subtree task title; D8 lists none of them.
Fix: Applied: new section 'Status data this document needs', by meaning, for the architecture spine.

**Component coverage** — Rules sorted by lists of lifecycle states (§ STOPPED order; Board card; Peek)
Contradicted the doc's own classification rule and the D9 audit (AC 11, CRITICAL).
Fix: Applied: STOPPED groups by the D2 dead set (from the status), the blocked tag and the rest; reasons shown when the field exists; presentation maps named as the D9 allowlist exception.

**Decision conformance** — AC 22 fails at normal sizes (§ Design placement 'Height'; Open Question 3)
The scenario list clipped on a 13-scenario run at 120 x 40.
Fix: Applied: one shared region as a scroll box in every expanded view, pageup/pagedown in full-screen views and the Ticker dialog; Open Question 3 closed; a 120 x 40 fixture check named.

**Structure and prose** — 'cause' had two meanings (§ State vocabulary; STOPPED list)
A group of tasks and the 'blocked by' sentence.
Fix: Applied: groups 1-3; 'cause' only for the blocked sentence.

### Medium (16)

**Decision conformance** — No source for the run duration (§ Closing summary; HUD; Gantt axis)
Today these come from the history, which the doc forbids.
Fix: Applied: run start and end times in the status contract.

**Decision conformance** — 'Run not live' cap conflicts with D21 (§ Durations)
A TUI-derived end time; the live check is also false in another session.
Fix: Applied: cap dropped; moved to Open Question 1.

**Decision conformance** — Sidebar zero lines return after the summary (§ Run usage)
The summary is an assistant message in the root; the rule was not limited to /task roots.
Fix: Applied: /task root sessions only; the existing output-tokens filter hides the root's own lines.

**Decision conformance** — Board fails AC 21 under about 91 cells (§ STOPPED list; Responsive)
The STOPPED column is cut first and the Board had no STOPPED list.
Fix: Applied: the Board shows the STOPPED list in its shared region too.

**Decision conformance** — No tmux pane size for AC 27 (§ Key Flows intro)
At tmux's default 80 x 24 the sidebar and the Board's right pane do not show.
Fix: Applied: 200 x 50 pane and the design for each capture.

**Component coverage** — Peek heading shows a blocked cause twice (§ Peek BUILDER heading)
Line 1 and lines 2-3 both carried the cause, in two tones.
Fix: Applied: the sentence starts on line 1 and wraps, in one tone.

**Component coverage** — Full reason unreadable during the run (§ Peek; Accessibility Floor)
The 3-line cap cut the doc's own example in the 38-cell Ledger.
Fix: Applied: the Peek heading wraps with no line cap; the activity lines shrink first.

**Component coverage** — Ledger second line has no width budget (§ Run header; Design placement)
About 7 cells were left for the run title.
Fix: Applied: the run title has its own Ledger line.

**Component coverage** — Gantt lane rule incomplete (§ Durations)
No running glyph, no post-end rule, no blocked lane, no legend text.
Fix: Applied: lane, legend and Matrix legend specified.

**Component coverage** — Spinner cannot draw bold; Brand sits inside text (§ In the Flow mark)
opentui-spinner draws no attribute and runs one shared scheduler.
Fix: Applied: diamond not bold in either form; each Brand becomes a row; timer sentence corrected.

**Component coverage** — SCENARIOS two-column fill order unstated (§ SCENARIOS list)
The mock fit neither order; reasons give columns different heights.
Fix: Applied: column-first fill, independent column stacks, mock rebuilt with real titles.

**Component coverage** — Multi-line run reason on one-line surfaces (§ Component Patterns)
D3 and D10 make the reason multi-line.
Fix: Applied: 'Run reason line' = first line plus ' (+N more)'.

**Inheritance discipline** — Header title source unstated (§ Run header)
Reading status.json would re-title every older header in scrollback.
Fix: Applied: the header message carries its own structured field.

**Inheritance discipline** — Voice rule broken in two literal strings (§ Watch band; D13 refusal)
'The run waits on' and 'depends on'.
Fix: Applied: 'The run is waiting on' and 'is after'.

**Inheritance discipline** — Summed tokens undefined (§ Run usage)
Summing the context figure would count cache reads again and again.
Fix: Applied as an assumption: input + output + reasoning, cache excluded.

**Structure and prose** — Several wording and structure items (§ Throughout)
'Mark' vs the component, 'columns' for width, raw colour names in flows, durations table column, state label term, Flow 2 step 6 length.
Fix: Applied.

### Low (0)

### Low

About 50 low findings across the three reviews: mock arithmetic (4/6 + 1 + 2 = 7), mock titles, legends, refusals without a rule number, the hour form of elapsed, design 7 'as today', Ticker under 108 cells, the scenario title's leading id, '$0.00' on purpose, idioms and compound tenses. Applied, except the Component Patterns index rows (kept as the one-table index for extractors) and the width facts repeated in two sections (kept; they agree).

## Mechanical notes

- Anchors: 26 internal links, 0 broken after the rewrite.
- ../architecture/ARCHITECTURE-SPINE.md does not exist yet; a parallel run writes it. Re-check the link and the status-data hand-off when it lands.
- D13 'Left out' header line has no flow (low, accepted).

## Open questions (none blocks [CS])

- A run that stopped moving: should the engine record a fact so the diamond and live durations stop?
- Does a later valid stale check clear the D12 run warning?
- Can the status carry phase intervals so the Gantt keeps its build/prove/verify shading?
- Should the root session's title take the spec title?

## Reviewer files

- `review-rubric.md`
- `review-decisions.md`
- `review-structure-prose.md`
