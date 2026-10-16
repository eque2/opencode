# Scenario-phase findings for the owner

Spec wording gaps and observations that the scenario verifiers raised. None blocks a verdict.

- RM8c (trusted 2026-10-16): the scenario header's "observed facts" (T1.1–T1.3 trusted, T1.4 exhausted) do not fold to
  `done` alone: under D3 and RM10, S2, S3, S4, S7 and S12 stay pending. The test uses the real observed slice, in which
  the old runner proved those scenarios during T1.4's builds. Reword the header or RM8c to name the scenario facts.
