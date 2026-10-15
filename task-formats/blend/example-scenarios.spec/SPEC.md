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
  EX-D1: "Plain TypeScript with no runtime dependency; `strict`, no `any`; pure functions with no I/O, no clock and no randomness."
---

# Slugs for release titles

A live-check spec (D15): one leaf task and one scenario, so a short paid run reaches the acceptance stage and runs a
scenario. Every path resolves from the root of the demo folder that `packages/opencode/script/task-demo.sh` seeds
from `packages/opencode/test/task-harness/release-notes-repo/`: an empty `src/` and an empty `test/`.
