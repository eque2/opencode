---
after: [T1.3, T1.6]
touches:
  - path: libs/media/src/provider-router.ts
    change: update
    what: "a pair configured with zero enabled providers fails with a new typed error instead of falling through to default precedence"
refs: [POA-R1, POA-D4, POA-D7, EFF-10]
---

# Update the router so a pair configured to serve nothing is not treated as unconfigured

## Goal

Make a deliberately-emptied pair fail loudly instead of silently reverting to the built-in default.

## Approach

This is the one genuine semantic change to `provider-router.ts`. Today an absent entry and a serve-nothing entry are indistinguishable; after this they must not be. Add a tagged failure alongside the existing `NoCandidateSatisfiesConstraints` rather than reusing it — the operator response differs completely ("your constraints excluded everything" versus "you switched everything off").
