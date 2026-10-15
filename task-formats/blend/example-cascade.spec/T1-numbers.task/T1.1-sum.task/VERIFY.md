---
ensures:
  c1:
    category: happy-path
    text: "The release gate BUILD-1 passes at the task's final commit."
    proof: {gate: BUILD-1}
policy:
  budgets: {taskAttempts: 1}
---

# Verify

The only proof is the gate BUILD-1, whose command exits 1 on every run, so no edit can make it pass.
