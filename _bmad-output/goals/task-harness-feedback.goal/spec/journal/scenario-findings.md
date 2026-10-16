# Scenario-phase findings for the owner

Spec wording gaps and observations that the scenario verifiers raised. None blocks a verdict.

- RM8c (trusted 2026-10-16): the scenario header's "observed facts" (T1.1–T1.3 trusted, T1.4 exhausted) do not fold to
  `done` alone: under D3 and RM10, S2, S3, S4, S7 and S12 stay pending. The test uses the real observed slice, in which
  the old runner proved those scenarios during T1.4's builds. Reword the header or RM8c to name the scenario facts.
- RM5 (writer's note, before the trust verdict): "the log grows exactly when the state or another context field changes"
  is not literal: `run.resumed`, a second `run.started` and a repeated `spec.checked` add a run note and change nothing
  else; the spine (AD-5, the fact table) requires those notes. The test allows only these three. An owner ruling can
  close the wording.
