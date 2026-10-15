---
format: task-spec/1
policy:
  redFirst: true
  proofBinding: title-tag
  structural: touches-plus-tests
  review: parent-diff
  trust: independent-verifier
  acceptance: after-all-needs-trusted
  evidence: [exit-code, counts, run-id, commit]
  budgets: {taskAttempts: 2, retries: 1}
  judges:
    test: [runner, verifier]
    gate: [runner]
    unchanged: [engine]
    review: [reviewer]
gates:
  BUILD-1:
    title: "Tests pass"
    command: "bun test"
    requires: "Bun 1.3"
refs:
  EX-D1: "Plain TypeScript with no runtime dependency; `strict`, no `any`; pure functions with no I/O."
---

# Word helpers (a task after itself)

A fault folder (D14). It plants one fault: T1.1 is after T1.1 (R7).
