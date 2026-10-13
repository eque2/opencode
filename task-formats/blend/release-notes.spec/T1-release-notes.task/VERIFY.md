---
ensures:
  e1:
    text: "The combined T1 diff passes one independent review once the last child is trusted: the five modules meet RN-D1 and RN-D2, the output format is the one T1.3 defines, and the seed's scripts and dev dependencies are unchanged. Fixes land in their own commits, and the children they touch are judged again."
    proof: review
---

# Verify

A parent is trusted when every child is trusted and its own obligations are met.
