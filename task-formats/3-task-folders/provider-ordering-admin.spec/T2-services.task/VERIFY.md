---
verifies: T2
---

# Verify T2

- Every child task is trusted.
- One independent review of the combined T2 diff once the last child is trusted. Fixes land in their own
  commits, and the children they touch are judged again.
