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

# Word helpers (a subtree run with a folder task outside it)

A valid spec: T1.2 is after T1.1. As a whole spec it loads with no failure. As the T1.2 subtree it is refused
at the start, because T1.1 is outside that run and not trusted (D13).
