# Acceptance criteria

<!--
  TEMPLATE — {skills-root}/eque2-code-prepare-goal/assets/ACs-template.md
  Format contract: ../references/acs-format.md   (NORMATIVE — read it)
  Checker:         {skills-root}/eque2-code-goal-gate/acs-format-check.sh

  THIS TEMPLATE IS INVALID AS SHIPPED, ON PURPOSE.
  It contains zero criteria, and zero criteria is an ERROR (exit 2), never
  "all complete". A template that validated while empty would report done
  before a single criterion existed. Replace the examples below with real
  criteria; delete this comment when you do.

  Validate at any time:
      bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh ./ACs.md
      bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh --authoring ./ACs.md

  THE SIX RULES
  1. A criterion is a top-level task item: exactly `- [ ] `, `- [x] `, or
     `- [!] ` (blocked).
  2. Every criterion NAMES ITS SPECIFIED SYSTEM as a backticked path, entry
     point, or command. Prose names nothing. A reference to a mock, stub, fake,
     dummy, stand-in, placeholder, sample or example is REFUSED — a criterion
     satisfied by a surrogate fails the format before it can pass the gate.
  3. A TICKED criterion carries a non-empty `- evidence:` line. No evidence,
     no tick: `ticked-without-evidence` (exit 5).
  4. An UNTICKED criterion carries a written `- explanation:` line saying why
     it is not met: `unticked-without-explanation` (exit 6).
  5. A BLOCKED criterion carries a non-empty `- blocked:` line saying what is
     blocking it: `blocked-without-reason` (exit 8). Blocked is neither met nor
     outstanding — it stops driving the nudge and NEVER buys a pass. Use it only
     when a criterion genuinely cannot be met; a loop whose remaining work is
     all blocked ends as a REPORTED NON-COMPLETION, not as success.
  6. `**CRITICAL**` goes immediately after the checkbox, or not at all.

  Fields are indented under their criterion, and belong to exactly one state:
  `evidence:` to `[x]`, `explanation:` to `[ ]`, `blocked:` to `[!]`. A field on
  the wrong state is an error (exit 4). `- at:` is optional and always allowed.
-->

Goal: <one sentence — what "done" means for this workstream>

## Done when

<!-- ---------------------------------------------------------------------
     EXAMPLES — indented, so they are NOT criteria (only top-level `- [ ]`
     items are). Copy one to column 0 and edit it; delete this block.

     A met criterion:

       - [x] **CRITICAL** A zero-criteria file is rejected rather than reported complete — `{skills-root}/eque2-code-goal-gate/acs-format-check.sh`
             - evidence: `bash acs-format-check.sh fixtures/empty.md` → `acs-format: no criteria found` (exit 2)
             - at: 2026-07-19T14:02:11Z

     An unmet criterion:

       - [ ] The gate refuses to permit a stop while any criterion is unticked — `{skills-root}/eque2-code-goal-gate/run-all.sh`
             - explanation: not yet implemented; the gate script does not exist.
               Blocked on the run-all wiring task.

     A blocked criterion — genuinely cannot be met, so it stops driving the
     nudge. It is NOT met, and the loop it belongs to cannot pass because of it:

       - [!] The staging smoke test runs green — `scripts/smoke.sh`
             - blocked: needs production credentials this run does not have and cannot mint.
     --------------------------------------------------------------------- -->

<!-- Write real criteria here. Until you do, this file is invalid. -->

## Notes

<!--
  Free prose. Ignored by the checker — only top-level `- [ ]` / `- [x]` items
  are criteria.
-->
