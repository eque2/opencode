# The `ACs.md` format contract

Normative. `ACs.md` is the acceptance contract of a workstream: the single file
that decides whether the work is done. It lives in the workstream's goal folder
(`X.goal/ACs.md`, see `goal-folder.md`) and is the file the completion gate reads.

Supports **S3** (`ACs.md` generation with checkboxes), **S4** (the gate blocks on
unchecked boxes and allows on all-checked), and **S6** (an unmet criterion carries
a written explanation).

**Everything below is executable.** The rules are enforced by
`{skills-root}/eque2-code-goal-gate/acs-format-check.sh` (§7), not asserted in prose.

---

## 1. Why this format exists

The source brief's complaint is that a check can be satisfied by *a testable
surrogate standing in for the specified system* — the thing under test is
replaced by something convenient, the box goes green, and nothing real was
verified. A checklist that is merely "boxes an agent ticks" reproduces that
failure exactly: the agent that did the work also grades it, with no record.

This format closes that in two moves:

1. **Every criterion must name its specified system** — a real path, entry point,
   or command (§3.3). A criterion phrased against a mock, stub, or stand-in is a
   **format error**, so the failure the brief describes cannot even be written
   down as a met criterion.
2. **Every ticked criterion must carry evidence** (§4). A tick with no `evidence:`
   line is refused as `ticked-without-evidence`.

**Honest scope.** This is an *integrity-of-record* mechanism, not proof of
execution. The checker verifies the presence and shape of evidence; it cannot know
whether the command truly ran. What it guarantees is that no criterion can be
marked met silently, and that every claim is on the record, attributable, and
cheap to audit — the cost of a false tick rises from "type an x" to "fabricate a
command and its output", and the fabrication becomes a visible artefact.

## 2. Fail closed

Every unknown, error, missing input, or unrunnable check resolves to **not done**.

In particular, **zero criteria is an ERROR, never "all complete"** — the
vacuous-truth trap. A file with no criteria, an empty file, a missing file, and an
unreadable file are all *not done*, and each exits non-zero with a diagnostic.
There is no path on which an unknown resolves to "met".

## 3. A criterion

A criterion is a **top-level markdown task-list item**. Nothing else in the file
is a criterion; prose, headings, and notes are ignored.

```
- [ ] <text naming the specified system>
- [x] <text naming the specified system>
- [!] <text naming the specified system>
```

### 3.1 Checkbox syntax

Exactly `- [ ] ` (unticked), `- [x] ` (ticked), or `- [!] ` (blocked), at column
0, with a single trailing space. A line that opens `- [` at column 0 but does not
close in one of those three exact forms — `- [X]`, `- []`, `- [y]` — is a
**format error**: a checklist whose state cannot be read unambiguously is not a
contract, and a near-miss is far likelier to be a typo in a real criterion than
deliberate prose.

The two-state rules for `- [ ] ` and `- [x] ` are **unchanged** by the addition
of the third state. A checklist written before `- [!] ` existed validates
exactly as it did, and yields the same counts and the same exit code.

**Why `[!]` and not `[-]`.** `[-]` reads as "partially done" in several markdown
flavours, and `parse-acs.sh` already lists it as checkbox-like prose in
`pacs_has_checkbox_text`. An already-ambiguous token is the wrong one to make
load-bearing: `[!]` is unused, and it reads as "attention" rather than "half
finished", which is what a blocked criterion is.

An **indented** task item is not a criterion and is not an error — it is ignored,
along with all other non-criterion content. This is what lets the template carry
worked examples, and prose carry illustrations, without either becoming part of
the contract. Criteria are top-level items, and only top-level items.

### 3.2 The critical-importance marker

A criterion of critical importance carries the literal marker `**CRITICAL**`
**immediately after the checkbox**, followed by a single space:

```
- [ ] **CRITICAL** The gate refuses to permit a stop — `{skills-root}/eque2-code-goal-gate/run-all.sh`
```

The marker appearing anywhere else in the criterion text is a format error: the
marker is a machine-read field, not emphasis. Criticality does not change how a
criterion is validated; it changes how it is **reported** — the checker emits
`critical` and `critical_unchecked` counts so a consumer can distinguish "two
minor items outstanding" from "the load-bearing criterion is unmet".

### 3.3 Naming the specified system — the load-bearing rule

Every criterion MUST reference its specified system as a **backtick-quoted path,
entry point, or command**, and that reference must look like one: it contains a
directory separator (`/`) or a filename extension (`.`).

```
- [ ] Zero criteria is rejected — `{skills-root}/eque2-code-goal-gate/acs-format-check.sh`
```

Two things are rejected:

| Rejected | Why |
|---|---|
| No backticked reference at all | Prose alone ("the parser rejects empty files") names nothing verifiable. |
| A reference naming a surrogate | `mock`, `stub`, `fake`, `dummy`, `surrogate`, `stand-in`, `standin`, `placeholder`, `sample`, `example`, `simulated`, `toy` (case-insensitive, anywhere in the reference). |

The second is the brief's failure, made unwriteable. A criterion satisfied by a
stand-in fails the **format**, before anyone asks whether it passed.

## 4. Evidence — the ticked state

A ticked criterion MUST be followed by an **indented** `- evidence:` line whose
value is non-empty:

```markdown
- [x] **CRITICAL** Zero criteria is rejected — `{skills-root}/eque2-code-goal-gate/acs-format-check.sh`
      - evidence: `bash acs-format-check.sh fixtures/empty.md` → `acs-format: no criteria found` (exit 2)
      - at: 2026-07-19T14:02:11Z
```

- A ticked criterion with **no** `evidence:` line, or with an **empty** one, is
  refused as **`ticked-without-evidence`** (exit 5). This is the single most
  important rule in the format: it is what stops a self-certified tick.
- `evidence:` should carry a command, an observed result, or a named artefact —
  not prose alone.
- `- at:` (an ISO-8601 timestamp) is **optional** and recommended; it makes the
  record attributable in time. It is not validated.
- A ticked criterion MUST NOT carry an `explanation:` line (§6).

## 5. Explanation — the unticked state

An unmet criterion MUST carry an indented `- explanation:` line: *why* it is not
met. An unexplained unmet criterion is refused as
**`unticked-without-explanation`** (exit 6).

```markdown
- [ ] Live registration is verified — `{skills-root}/eque2-code-goal-gate/register.sh`
      - explanation: blocked on T3.4; the live invocation has not been run yet.
```

There is no length limit on an explanation; a very long one is valid.

**The one relaxation.** The requirement acquires force only once the completion
loop has run an iteration — a freshly emitted checklist has nothing to explain
yet. The checker therefore accepts `--authoring`, which relaxes **this rule and
only this rule**. The default is strict, so the fail-closed reading is what you
get unless a caller deliberately asks for authoring mode.

## 5.5 Blocked — the third state

A criterion that **genuinely cannot be met** is marked `- [!] ` and MUST carry an
indented `- blocked:` line whose value is non-empty: *what* is blocking it.

```markdown
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials the run does not have and cannot mint.
```

A blocked criterion is **neither met nor outstanding**. It is excluded from the
outstanding count, so it stops driving the nudge, and it is never added to the
met count, so blocking never buys a pass. Blocking is how a loop ends **honestly**
when the remaining work is impossible — as a reported non-completion
(`LOOP_PARTIAL`), not as success.

- A blocked criterion with **no** `blocked:` line, or with an **empty** one, is
  refused as **`blocked-without-reason`** (exit 8). A blocker with no stated
  reason is indistinguishable from an escape hatch, which is exactly what this
  state must not become.
- A blocked criterion MUST NOT carry an `evidence:` or an `explanation:` line
  (§6). Those belong to the other two states, and a criterion carrying fields
  from two states has not decided which state it is in.
- Symmetrically, a `- [x] ` or `- [ ] ` criterion MUST NOT carry a `blocked:`
  line — it is a misused field (exit 4).
- `--authoring` relaxes the **unticked explanation rule only**, and never the
  blocked-reason rule. A blocker is written down at the moment it is discovered,
  which is never "before the loop has run".
- A blocked reason is **prose by nature** ("needs production credentials"). It is
  NOT subject to §3.3's surrogate rule or to the evidence-substance rule; those
  apply to `evidence:` values. Demanding a command of a reason would make honest
  blockers unwriteable.
- `**CRITICAL**` is legal on a blocked criterion, and is reported rather than
  rejected: "the load-bearing criterion is blocked" is a materially different
  report from "two minor items are blocked".

**A checklist whose criteria are ALL blocked is not a pass.** It has zero met
criteria, and zero met is never done — the vacuous-truth trap in its new form.

## 6. Fields are mutually exclusive by state

| State | `evidence:` | `explanation:` | `blocked:` |
|---|---|---|---|
| `- [x]` ticked | **required**, non-empty | forbidden | forbidden |
| `- [ ] ` unticked | forbidden | **required** (relaxable via `--authoring`) | forbidden |
| `- [!] ` blocked | forbidden | forbidden | **required**, non-empty, never relaxable |

Every misplacement is an error rather than a warning: a ticked criterion that
explains itself instead of evidencing itself is precisely the self-certification
this format exists to prevent, and a blocked criterion that evidences itself is
claiming to have done the thing it just said it could not do.

A criterion's fields are the indented lines that follow it. A **blank line does
not end** a criterion; any unindented non-list content does.

A field line that belongs to no criterion is a format error — **unless** it
follows an indented task item (§3.1), in which case it is part of that
illustration and is ignored with it. This is what lets the template and prose
carry a worked example in full, fields and all, without the example becoming
part of the contract or tripping an orphan-field error.

**Precedence.** Format errors are reported before the zero-criteria verdict. A
file whose only criterion is malformed has both problems, and the checkbox error
is the actionable one — "no criteria found" would send the author hunting for a
missing criterion that is in fact right there. Both exits are non-zero and both
mean *not done*, so the ordering trades no safety.

## 7. Normative implementation

The single normative implementation of this document is:

**`{skills-root}/eque2-code-goal-gate/acs-format-check.sh`**

```
acs-format-check.sh [--authoring] <ACs.md path>
```

On success it prints machine-readable counts to stdout and exits 0:

```
total=6
checked=3
unchecked=2
blocked=1
critical=2
critical_unchecked=1
```

Failures print an `acs-format:` diagnostic to stderr and exit non-zero:

| Exit | Meaning |
|---|---|
| `0` | valid |
| `2` | no criteria found — the vacuous-truth trap; zero criteria is never "done" |
| `3` | input missing, a directory, not a regular file, or unreadable |
| `4` | format error — checkbox syntax, missing/surrogate system reference, misplaced or misused field (including `blocked:` on a ticked or unticked criterion) |
| `5` | `ticked-without-evidence` |
| `6` | `unticked-without-explanation` |
| `8` | `blocked-without-reason` — a `- [!] ` criterion with a missing or empty `blocked:` line |
| `64` | usage error |

**Why 8 and not 7.** `7` is already taken: `validate-acs.sh` uses it for
`evidence-not-substantive`, and the gate maps both delegates' codes through a
single table. Reusing 7 would make two different refusals indistinguishable at
the one place that has to tell them apart.

The script may also be sourced; `acs_format_check` is the entry point, and
sourcing does not alter the caller's shell options.

**Layering.** This script owns the *format* of one `ACs.md`. The gate-side
validator `validate-acs.sh` (a separate task) owns wiring into `run-all.sh`, the
run-log emission, and the per-criterion decision trail; it consumes this checker
rather than re-implementing these rules.

## 8. The template

**`{skills-root}/eque2-code-prepare-goal/assets/ACs-template.md`** is the shipped starting
point. It contains **zero criteria** and is therefore **invalid by construction**
(exit 2) — deliberately. A template that validated while empty would be a
checklist that reports "done" before anyone wrote a criterion, which is the
vacuous-truth trap shipped as an asset. It must be filled in before it means
anything.

## 9. Conformance

`{skills-root}/eque2-code-goal-gate/tests/test-acs-format.sh` is the conformance suite for
this contract. It exercises the checker across happy path, invalid input,
boundary, empty/null, and state-transition classes, prints a PASS/FAIL line per
test, and exits non-zero if any test fails. Changing this document without
changing that suite is a defect.
