# Review — EXPERIENCE.md update against the decisions and the architecture spine

Reviewer: adversarial decision-conformance review, 2026-10-14.
Under review: the changed sections of `ux/EXPERIENCE.md` (the bmad-ux Update path; memlog entries from "update:
architecture spine landed").
Binding: `decisions.md` D1–D27, `ACs.md` (AC 1 = README … AC 18 = D16 … AC 25 = D23, AC 26 = D24, AC 27 = D25, AC 29 =
quality gate), `architecture/ARCHITECTURE-SPINE.md` AD-4, AD-5, AD-13–AD-19, and the owner answers and prepare-goal
defaults (a)–(f) of 2026-10-14.

## Overall verdict

The update brings the document into line with the spine: every `status.json` field name matches AD-13, the Board
column, the STOPPED groups and the severity order read tags, the refusal follows AD-14, the busy reply follows AD-19,
and the liveness, diamond, duration and Gantt rules follow AD-16 with defaults (c) and (e). One high defect remains: the
closing summary's outcome rule ignores AD-4 rule 1, so a run stopped by the run wall clock reads "failed: acceptance
not proved". Five medium gaps (state-name lists, an incomplete display table, the run reason line on a `done` run, two
meanings of "live", and the AC 23/AC 25 verification reading) should be fixed before `[CS]` writes scenarios.

## Changed sections

| # | Changed section | Verdict | Note |
|---|---|---|---|
| 1 | Intro paragraph | conforms | Names AD-13, AD-14, AD-15, AD-16 and AD-18 as owners; the frontmatter cites the spine. |
| 2a | Foundation: Data | conforms | Every `run`, `tasks`, `scenarios`, `outside`, `external` field name matches AD-13. Notation and omissions in L7. |
| 2b | Foundation: Liveness | conforms | Matches AD-13 (`now - run.aliveAt <= 15 s`) and AD-16 (`live`/`still`/`ended`) and default (c). Omits `absent` (L7). |
| 2c | Foundation: Classification | conforms / gap | Tags, `liveness` and times only; DISPLAY is the one state-keyed table. The table does not carry the Board column or the scenario-only states (M2). Gantt block in DISPLAY is an addition (L11). |
| 3 | Information Architecture: Refusal, Busy reply rows | conforms | AD-14 and AD-19 cited. |
| 4 | Voice and Tone: prefix, verbatim, Do/Don't rows | conforms | The verbatim rule correctly keeps AD-4's "waits on". The external row matches AD-15 and (f). The busy row matches AD-19 and (b). |
| 5 | State vocabulary | conforms / gap | Every tags cell matches the AD-13 class table; `stalled` correctly has no tags. Board column and STOPPED group rules read tags (AD-16). Gaps: M2, L5. |
| 6 | Component Patterns rows | conforms / gap | Busy reply, Stopped count (`stopped` tag), Ticker toast (`dead`/`blocked` tags) and Watch band (no command for external ids) conform. Run reason line has no rule for a `done` or `cancelled` run that carries a reason (M1). |
| 7 | Run header (D17) | conforms | `metadata.taskHarness.header = { spec, task?, leftOut }` matches AD-13 exactly; `run.title` fallback matches AD-13. |
| 8 | Refusal (D10, D13) and Busy reply | conforms | Header line, then exactly the `run.reason` lines, then a hint (AD-14); D13 uses the R12 line verbatim; plain-line form has no count. Busy reply names spec and path from the lease (AD-19, (b)). Minor wording gaps in L1, L10. |
| 9 | Closing summary (D18) | contradicts / gap | Outcome table and the "acceptance form" rule mis-handle AD-4 rule 1 (H1). Rule 3 with parked scenarios has no form (L4). "Rejected scenarios" selects by state names (M3). Mock counts break the counts rule (L3). "Not run" section, `Ops.say`, `run.endedAt − run.startedAt` and the `spec.checked` history read conform (AD-4 rule 4, AD-5, AD-18). |
| 10 | Run warning (D12) | conforms | `run.warning` lines, AD-14 format, cleared by the next valid reload (AD-12). |
| 11 | Outside wait line (D4) | conforms | `waitingOnOutside` with `outside[id].state` `untrusted`, run not ended (AD-16). External ids never get a command or a wait line (AD-15, (f)). Transience of external waits in L8. |
| 12 | In the Flow mark: liveness bullet | conforms | Animates only in `live`; static in `still`/`ended`/animations off; a run waiting on `/task trust` in a live job keeps moving (AD-16, (c)). Not a contradiction of D23 or AC 25, but the verification reading must be explicit (M4). |
| 13 | STOPPED list (D19) | conforms | Members by `stopped` tag; groups `dead`, `blocked`, rest (AD-16). Id order inside a line is unstated and the mocks disagree with tree order (L9). |
| 14 | SCENARIOS list (D20) | conforms / gap | Entry, `waitingOn`/`waitingOnOutside`/external, "not run" (tag `waiting` after `ended`) and `blocked` bullets read tags and fields. The "rejected or failed" bullet classifies by state names (M3). |
| 15 | Board card (D16) | conforms | Lines 2–3 and the reason read tags and AD-13 fields; tones by `dead` tag. Order rule can conflict with tree order (L9). |
| 16 | Peek BUILDER heading | conforms | Tag-keyed branches; "Did not start" keys on `endedAt` without `startedAt`. |
| 17 | Durations (D21) and Gantt lane | conforms / gap | Live/Still/Fixed/Blank and the run span match AD-5, AD-16 and (c). The Gantt draws `tasks[].spans`, open span to now (to `run.aliveAt` in `still`), blank before the first span, infers no state (AD-16, (e)). "Never changes again" misses the AD-5 stale reopen; the "Stopped." label collides with the `stopped` tag; cancelled `░` vs the legend (L5, L6). |
| 18 | Run usage (D24) intro | conforms | One definition of the run's sessions (AD-18); cost not in `status.json` (AD-13). |
| 19 | State Patterns rows | conforms / gap | Outside, external, task died, spec warning, failed-every-task-trusted, dead task, refused and second `/task` rows conform. "Stands still" leaves two meanings of "live" (M5). "Done" and "cancelled" do not say what the run reason line does (M1). No row for a wall-clock stop (H1). |
| 20 | Accessibility Floor: Motion | conforms | Static while the run stands still, per (c). |
| 21 | Key Flows: Flow 1 Failure, Flow 2 Failure, Flow 4 step 2 and D13 variant | conforms | Flow 1 Failure matches AD-4 rule 3 and (a). Flow 2 Failure matches AD-19. Flow 4 lists R1, R4, R3 (D14). D13 variant path placeholder is ambiguous (L2). |
| 22 | Own-judgment, Open Questions, Deferred, Assumptions, removed "Status data" section | conforms | Every removed hand-off item maps to an AD-13 field (`run.title`/`specId`, `run.task`, `startedAt`/`endedAt`, `run.reason`, `run.warning`, `dead` tag, `reason`/`blockedBy`, `waitingOn`/`waitingOnOutside`, scenario `title`). Open questions 1–3 are answered by AD-13/AD-16, AD-12 and AD-5; 4 is deferred per (d). Small gaps in L10, L11. |

## Findings

- **[high] H1.** The closing summary's outcome rule does not cover AD-4 rule 1 and mislabels it. AD-4 rule 1 (a noted
  stop) gives `cancelled`, or the `run.ended` state, and the run wall clock records `run.ended { state: "failed" }`
  (AD-10). The units still in progress then move to `cancelled`, which carries `ended, stopped` but not `dead`. The
  document says "The acceptance form applies when `run.state` is `failed` and no task has the `dead` tag". So a run
  that hit its wall clock gets "Spec **<title>** — failed: acceptance not proved" in the transcript, even when no
  scenario ran. The outcome table has no row for this case, and State Patterns has no row for it either. D18 and AC
  20 require "the outcome", so this summary gives the user a wrong outcome. (Closing summary, outcome table and the
  sentence under it; State Patterns.) *Fix:* add a row "`failed` by a stop (AD-4 rule 1, the run wall clock) |
  Spec **<title>** — failed: <first line of `run.reason`>". Apply the acceptance form only when `run.state` is
  `failed`, no task has the `stopped` tag, and the slice's history holds no stop entry. The summary actor already
  reads the history for `spec.checked` (AD-18). Add the matching State Patterns row.
- **[medium] M1.** The run reason line shows any `run.reason` in `{theme.error}`. After AD-4 rule 4, a `done` run can
  carry a reason ("not run: S13 waits on T8"). So a successful run shows a red reason line in the Ledger, the
  full-screen header, the Dock, the HUD and the Ticker notification. The State Patterns rows disagree. "Run ended:
  done" lists no run reason line. "Dead task" reads "As done, plus the run reason line". "Run cancelled" reads "As
  done", yet a cancelled run carries the stop reason. (Component Patterns, Run reason line; State Patterns "done" and
  "cancelled".) *Fix:* show the run reason line in `{theme.error}` only when the run has the `stopped` tag (AD-13: a
  `done` run is `ended` only). For a `done` run, show its "not run" lines in `{theme.warning}`, or leave them to the
  SCENARIOS list. Say so in both State Patterns rows.
- **[medium] M2.** The display table is not complete enough to stay the only state-keyed table (AD-16, AD-17 `DISPLAY`).
  The Board rule sends an `active` task "to the column of its phase … with its state as the display key". The table
  has no column field, though, because the update dropped the old "Board column" column. The SCENARIOS list and the
  summary colour scenario glyphs "in the state's tone", but the table has no row for the scenario-only states
  `pending` and `rejected`. A builder must then add a second map keyed by state names (`building → BUILDING`, or a
  scenario glyph map). The AD-17 allowlist does not name such a map, so the AC 11 audit (CRITICAL) fails or needs a
  new entry. (State vocabulary; Foundation, Classification.) *Fix:* add a "Board column" field for `building`,
  `proving` and `verifying`. Add `pending` (`·`) and `rejected` (`✗`) rows with their tones and Gantt blocks (or "—").
  Say that the scenario glyph line is part of the same table.
- **[medium] M3.** Two rules choose by a list of state names, which AD-16 forbids ("Each classification reads the status
  tags … A design uses a unit's `state` only as a key into that table"). In the SCENARIOS list, "A rejected or failed
  scenario has its `reason` under its entry … in `{theme.error}`". In the closing summary, "Rejected scenarios. Each
  rejected or failed scenario". AD-13 gives `rejected`, `failed` and `cancelled` scenarios the same tags (`ended`,
  `stopped`), so a builder can make this choice only with a state list. That list breaks the D9 audit in `task-ui/`
  and in `src/task/`. (SCENARIOS list, rejected bullet; Closing summary, Rejected scenarios.) *Fix:* in the SCENARIOS
  list, write "a scenario with the `stopped` tag, without `blocked`, and with a `reason` shows the reason under its
  entry, in its state's tone (display table)". Cancelled entries then show their stop reason in the muted tone. In
  the summary, list every scenario with the `stopped` tag and without `blocked`, with its state label and reason,
  under a heading such as "Scenarios that did not pass". This is a superset of D18. As an alternative, have the
  `summary` actor use an engine selector.
- **[medium] M4.** The rule "static in `still`" does not contradict D23 or AC 25. D23 animates "while the run is
  active", and a run that no live job owns is not active. D23 does not call its two static conditions exhaustive.
  The owner default (c) and AD-16 bind this reading. The same applies to AC 23 ("live while the task runs"). The
  verification reading is not written down, though, and a literal check can fail. AC 25's static clause names only
  "tags say ended" and "animations off". D23's "active" is not the run's `active` tag, because a run waiting on
  `/task trust` is tagged `waiting` and must keep moving under (c). AD-13's sanctioned fixture is written with
  `project`, and `project` does not stamp `run.aliveAt` (only the status writer stamps it, AD-9). A TUI test on that
  fixture therefore reads `still`. It shows a static diamond and blank durations for a building task, and fails AC 23
  and AC 25. (In the Flow mark, liveness bullet; Durations, Live and Stopped.) *Fix:* add one sentence in the In the
  Flow mark and in Durations: "AC 23 and AC 25 read 'active' and 'runs' as `liveness` `live` (default (c)), not as
  the run's `active` tag". Require every scripted AC 23 and AC 25 check to stamp a fresh `run.aliveAt` (or inject
  `now`). Add one check that a stale `aliveAt` freezes both.
- **[medium] M5.** The document now has two meanings of "live". The new `liveness` region uses the 15 s heartbeat. The
  unchanged Shortcut bar ("`tab` select task while the run is live") and the Interaction Primitives still mean
  today's `live` accessor. That accessor uses a 5-minute mtime window plus the `owns` check (`task-ui/index.tsx:101-110`,
  `LIVE_WINDOW` in `store.ts:81`), and it gates the `tab`/`esc` capture, the watch keys and the watch band
  (`ui.tsx:124,151`, `watch.tsx:399,439`). The changed row "Run stands still … Tab and `esc` leave the run alone, as
  today" ties the capture to `still` without saying which rule decides. AD-16 makes liveness one classification.
  (State Patterns, "Run stands still"; Shortcut bar; Interaction Primitives.) *Fix:* state that the `liveness` region
  replaces the `live` accessor and `LIVE_WINDOW`. The `tab`/`esc` capture, the watch keys and the watch band then
  read `liveness` `live` together with the existing `owns` check. Change "while the run is live" to "while `liveness`
  is `live`" in both tables.
- **[low] L1.** The refusal intro says "then one hint line", but the plain-line row has no hint. AD-14 says "one optional
  hint line". The section also does not say which answer wins when a run is live and the new `/task` names a faulty
  spec: the refusal or the busy reply. (Refusal, intro; Busy reply.) *Fix:* write "then one optional hint line". State
  the precedence, for example "the claim comes first, so a busy directory always gets the busy reply".
- **[low] L2.** The Flow 4 D13 variant uses "<T1.2 folder>" for two different paths. The header path is the `/task`
  argument as typed. The R12 path is "the run task's folder, relative to the spec" (AD-14). (Key Flows, Flow 4
  variant.) *Fix:* write "Refused task-formats/blend/example-outside-run.spec/<T1.2 folder>: 1 failure. …", then
  "R12 <T1.2 folder>: …".
- **[low] L3.** The closing summary mock breaks its own counts rule. S4 is listed under **Rejected scenarios**, and the
  blocked scenarios must also be counted, yet the counts line reads only "4/13 scenarios trusted". Two "blocked"
  counts in one line (tasks and scenarios) would also be ambiguous. "N scenarios not run" needs the singular "1
  scenario not run". (Closing summary, mock and outcome table.) *Fix:* make the mock follow the rule, for example
  "… · 4/13 scenarios trusted · 1 rejected · 8 blocked", or prefix the scenario counts ("scenarios: 1 rejected · 8
  blocked"). Give the singular forms.
- **[low] L4.** AD-4 rule 3 with a parked scenario has no outcome-line form. The reason then holds both "acceptance not
  proved" and "not run" lines. (Closing summary, outcome table.) *Fix:* add "Spec **<title>** — failed: acceptance not
  proved · N scenarios not run".
- **[low] L5.** The display table gives `cancelled` the Gantt block `░` in `{theme.textMuted}`. That block is identical to
  `waiting`. The legend also says "█ ended, in its state's colour", which `cancelled` contradicts. (State vocabulary;
  Gantt lane legend.) *Fix:* give `cancelled` `█` in `{theme.textMuted}`, or add "░ cancelled" to the legend.
- **[low] L6.** In Durations, "Fixed … It never changes again" is false after a stale reopen. AD-5 clears `endedAt` and
  starts `startedAt` again when a trusted task returns to `proving`. The new bullet label "**Stopped.**" also reuses
  the word of the `stopped` tag and the STOPPED column for a different meaning. (Durations.) *Fix:* write "It changes
  only when a stale check reopens the task (AD-5)". Rename the bullet "**Still.**".
- **[low] L7.** The Data bullet writes `tasks[]` and `scenarios[]`, but AD-13 makes both a `Record` keyed by id. It also
  omits `obligations`, which the Board "proofs k/n" line and the Matrix read. The verbatim rule names "the verdict
  reasons", a meaning-only reference. The Liveness bullet omits AD-16's `absent` state. (Foundation; Voice and Tone.)
  *Fix:* write `tasks[id]`/`scenarios[id]`. Add `obligations` (`state`, `tags`, `reason`). Replace "the verdict
  reasons" with `scenarios[].reason` and `obligations[].reason`. Add "`absent` with no status file".
- **[low] L8.** An external wait is transient. AD-15 refuses an untrusted external task at the start. For a trusted one,
  it records `outside.trusted` directly after `run.started`. A subtree run also leaves out every scenario whose needs
  fall outside it (D13). So "waiting on T1.1 (not in this run)" can show only on a task card or a Peek, and only for
  the short time between the two writes. It can never show on a scenario entry. (Outside wait line, External ids;
  State Patterns, external row.) *Fix:* say so, and tell `[CS]` to prove this text with a fixture status, not with
  the live check.
- **[low] L9.** The order inside STOPPED group 2 is not fixed. The STOPPED list says "Within a group, tasks keep tree
  order". The Board card says "A blocked card sits after the card of the task that its `blockedBy` names". These two
  rules disagree when a parent is blocked by its child. The mocks list "T1.5, T1", which contradicts tree order and
  the spine's natural id order. (STOPPED list; Board card; Closing summary mock.) *Fix:* state which rule wins. Order
  the ids inside a shared line by natural order ("T1, T1.5"), or say why not.
- **[low] L10.** The busy reply has three small problems. Its hint "stop it in its own session" does not help when the
  user is already in that session (Flow 2 Failure). The lease also holds no session id, so the reply cannot name the
  session. The mock wraps one line over two `┃` lines. The memlog entry records a different wording ("<title>
  (<path>) is running in this directory"). (Refusal, Busy reply; Flow 2 Failure; `.memlog.md`.) *Fix:* name the stop
  key ("or stop it with `esc` twice in its watch view, `ctrl+x w`"). Note that the mock is one wrapped line. Correct
  the memlog entry.
- **[low] L11.** The Assumption that DISPLAY also carries the Gantt block extends the AD-16 and AD-17 description "state
  to glyph and tone". The audit still matches one identifier, so it passes. The Own-judgment list also omits the
  outcome suffix "· N scenarios not run". (Assumptions; Own-judgment additions.) *Fix:* ask the architecture owner to
  widen the AD-17 `DISPLAY` description to "glyph, tone, Gantt block and Board column" (see M2). Add the suffix to
  the Own-judgment list.
- **[low] L12.** AC 4 still reads "the end state is done when every task is trusted". AD-4 rule 3 (owner answer (a)) makes
  such a run `failed` when a runnable scenario failed or was rejected. The document follows the owner answer. AC 4 and
  AC 20 evidence can therefore look like a deviation to a literal verifier. (Closing summary outcome table, Flow 1
  Failure; outside this document.) *Fix:* have the AC 4 and AC 20 evidence cite the owner answer of 2026-10-14 and
  AD-4 rule 3.
