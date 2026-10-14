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
    title: "A release gate that never passes"
    command: "sh -c 'exit 1'"
    requires: "a POSIX shell"
refs:
  EX-D1: "Plain TypeScript with no runtime dependency; `strict`, no `any`; pure functions with no I/O, no clock and no randomness."
---

# Number helpers that fail on purpose

A live-check spec (D15): T1.1 is proved only by a gate that always exits 1 and has one build attempt, so it ends
budget exhausted; T1.2 comes after T1.1 and is blocked by it; T1.3 has no `after` and ends trusted. Every path
resolves from the root of the demo folder that `packages/opencode/script/task-demo.sh` seeds from
`packages/opencode/test/task-harness/release-notes-repo/`: an empty `src/` and an empty `test/`.
