# RM5 verification journal (eque2-verifier, action: verify, batch RM2-RM6)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM5. No semantic verdict in this dispatch.
- State at start: RM5 not_started, untrusted, retryCount 0. No prior RM5 journal. The test file does not exist.
- Plan: read engine-xstate-random.test.ts (T1.8) and the spine AD-5 rule on targetless notes. Write
  packages/opencode/test/task/verify-spec-RM5.spec.ts: 40 seeded sequences of exactly 100 random facts over the
  release-notes plan, continued past the run's end; each folded with `apply`, sent to a live actor, and a prefix
  restored into an actor from the persisted fold and sent the rest; compare the three snapshots; check the log
  growth rule on every step. Keep the whole file under the adapter's 170 s limit on a loaded machine.
  Then `update RM5 start`, one adapter run, `verify RM5`.
- Known reading question: the spine prescribes history notes for `run.resumed` (fact table, "run history entry
  `resumed`") and for targetless rows, which add an entry with no other change. I will measure which facts do so
  before I decide how the test states the "exactly when" step, and I will record the decision.
- I write only the scenario test file. No source edits, no commits, no evidence or key reads.

## 2026-10-16 OUTCOME (test written, Layer 1+2)
- `update RM5 start`: not_started -> executing.
- Measurement (probe, then removed): on 40 seeds, steps whose log grew with no other change came only from
  `run.resumed`, a second `run.started` and a `spec.checked` that repeats the warning. No step changed the state or
  another context field without a log entry.
- Decision on the reading: the test keeps "a change appends to the log" strict, and allows a growth with no other
  change only for those three run notes (one entry, unit `run`, from === to). AD-5 ("a targetless row ... appends
  in its transition action"; "a targetless row that writes context always appends an entry") and the spine's fact
  table (`run.resumed`: "run history entry `resumed`") prescribe these notes, so the literal "exactly when" conflicts
  with the spine itself. The T1.8 verifiers (twice) took the same reading. The seed test titles say "bar the spine
  run notes", so no reader can miss it. A step whose log does not grow must return the identical snapshot.
- Wrote packages/opencode/test/task/verify-spec-RM5.spec.ts (41 tests: one per seed plus a summary; titles start
  with `[RM5]`). 40 sequences of exactly 100 facts, never cut at the run's end; fold with `apply`, live actor
  (`createActor(machine)`), restored actor (`getPersistedSnapshot` of a prefix fold, sent the rest); status, value,
  context and sorted tags compared. Control: a restored actor that misses one moving fact ends elsewhere.
- Coverage on the trial: all 40 runs ended (fact 7 to 86), 2213 facts after the end, 30 prefixes before the end and
  10 after, all 18 stored fact types, ids T7, T7.c1, S99; 1235 change steps, all with a log entry; 101 note steps
  (run.resumed 52, run.started 27, spec.checked 22).
- Trial: 41 pass, 10828 expect() calls, 26-48 s. tsgo: no error in this file. oxlint 0, prettier clean.
- Real run 20261016T123206Z-511216 at HEAD ca3b28b82d (sha256 prefix 63f53c58a039147b, load average ~22):
  bun exit 0, 41 pass, 93.9 s, handed-off, adapter exit 0.
- `verify RM5`: structural pass; state completed, trust untrusted -> verified.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier, batch RM2-RM6)
- Action: verify-scenario-trust (Layer 3). State at start: RM5 completed, trustLevel verified.
- Plan: read the RM5 Gherkin, tasks.md T1.8, the spine AD-5 text on run notes, and the test file; judge afresh the
  writer's reading of "the log grows exactly when the state or another context field changes"; run the file myself;
  then call `verdict RM5` exactly once. No source or test edits.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own bare run (load average 40): verify-spec-RM5.spec.ts -> 41 pass, 0 fail, 10828 expect(), 64 s.
- Judged afresh: the "exactly when" exception (run.started, run.resumed, spec.checked note-only growth) follows the
  spine's explicit rules (AD-5 targetless rows; fact table `run.resumed` history entry), and the machine's
  begin/resume/check actions write only that note. The test asserts the strongest true form and bounds the exception.
  The wording gap stays listed for the owner in journal/scenario-findings.md; it does not block the verdict.
- `verdict RM5 trusted` -> {"verdict":"trusted","trustLevel":"trusted"}.
