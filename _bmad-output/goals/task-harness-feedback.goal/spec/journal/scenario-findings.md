# Scenario-phase findings for the owner

Spec wording gaps and observations that the scenario verifiers raised. None blocks a verdict.

- RM8c (trusted 2026-10-16): the scenario header's "observed facts" (T1.1–T1.3 trusted, T1.4 exhausted) do not fold to
  `done` alone: under D3 and RM10, S2, S3, S4, S7 and S12 stay pending. The test uses the real observed slice, in which
  the old runner proved those scenarios during T1.4's builds. Reword the header or RM8c to name the scenario facts.
- RM5 (writer's note, before the trust verdict): "the log grows exactly when the state or another context field changes"
  is not literal: `run.resumed`, a second `run.started` and a repeated `spec.checked` add a run note and change nothing
  else; the spine (AD-5, the fact table) requires those notes. The test allows only these three. An owner ruling can
  close the wording.
- RM18 (trusted): the Gherkin step names "the phase-1 runner", which T2.12 deleted (120efaae43). The test drives the run
  supervisor that replaced it, with negative controls (it starts a task only from the ready tag, keeps no outside trust
  set and no done decision of its own). Reword RM18 to name the run supervisor.
- RM19's scenario test (verify-spec-RM19.spec.ts) keeps a 60 s bound for a 27–34 s walk; at a load of 120 one run took
  74 s. The unit test's bound is 180 s since 2e3884adf5; the scenario test may need the same before the final gate.
- SV9 (verifier's note, before the trust verdict): the alphabet keys an external region's trust on "the start-up step"
  as an empty log, but a real run records the trust straight after its own run.started (log length 1). The SV9
  Gherkin's exception list does not name it. The test accepts an external trust only in the start-up step (the job's
  first fact and the external trusts straight after it) and only when the empty-log alphabet holds it; its negative
  control refuses a later external trust. Name the start-up trust in SV9, or key the alphabet on the start-up step.
  Semantic verifier (2026-10-16, SV9 trusted): the test's reading meets the Gherkin. The spine (AD-7, AD-15, the fact
  table) puts the external trust in the alphabet "in the start-up step", and `run.started` is a listed exception that
  does not move the region. The wording gap stays open for the owner.
