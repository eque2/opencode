---
ensures:
  e1:
    text: "The combined T2 diff passes one independent review once the last child is trusted. Fixes land in their own commits, and the children they touch are judged again."
---

# Verify

A parent is trusted when every child is trusted and its own obligations are met.
