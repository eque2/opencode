---
id: T2
title: "Implement services — source, routing semantics, dry run, attribution"
phase: "2"
after: [T1]
---

# T2 — Implement services — source, routing semantics, dry run, attribution

Phase 2. The behaviour changes. Each subtask preserves a named property of the `provider-routing` workstream.

## Subtasks

The child `*.task` folders, in the order the engine may start them:

- [T2.1 — Add the `Database` routing-policy source variant](./T2.1-database-source.task/TASK.md)
- [T2.2 — Wire source selection, polling and load semantics](./T2.2-source-selection.task/TASK.md)
- [T2.3 — Update the router so a pair configured to serve nothing is not treated as unconfigured](./T2.3-serve-nothing-routing.task/TASK.md)
- [T2.4 — Add the dry-run mode to the gateway](./T2.4-gateway-dry-run.task/TASK.md)
- [T2.5 — Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical](./T2.5-attempt-boundary-short-circuit.task/TASK.md)
- [T2.6 — Write the routing-decision record and the generation attribution](./T2.6-routing-decision-record.task/TASK.md)
