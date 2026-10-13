# Coverage Categories Reference

Used by Stage 5 (Coverage Model) to construct the Scenario Category Map.

## Mandatory Baseline (always present)

These categories MUST appear in every coverage model. They cannot be marked N/A — if they don't apply directly to the feature being spec'd, capture that as a one-line note ("Performance N/A — feature is administrative, no SLA implied") but the category row stays in the model.

| # | Category | Why it exists | Coverage obligation |
|---|----------|---------------|---------------------|
| 1 | **Build & Quality Gates** | Every spec must verify the codebase still compiles, lints, builds, and unit-tests. These are the BUILD-1..4 baseline scenarios. | Minimum 4 scenarios (BUILD-1..4). Add BUILD-5 if Figma assets present. |
| 2 | **Delivery & Environment Promotion** | A feature that can't be deployed isn't done. | Minimum 1 scenario covering the deploy/promotion path. |
| 3 | **Core Business Outcomes** | The Verification Intent's promises must be verifiable. | One scenario per major behaviour named in Verification Intent (S1, S2, …). |
| 4 | **Negative Paths & Error Handling** | Most production failures come from unhandled error paths, not the happy path. | At least 1 scenario per major error class (validation, auth failure, external dependency failure, etc.). |
| 5 | **Permissions & Access Control** | When roles exist, role boundaries are a common attack surface and regression source. | If roles exist: at least 1 scenario per role-permission interaction. If no roles: explicit note. |
| 6 | **Data Integrity & Consistency** | Features that create or change data can corrupt state. | If data created/changed: scenarios for the consistency invariants (transactional boundaries, eventual consistency windows). |
| 7 | **Auditability & Supportability** | Regulated features need audit trails; supportable features need clear failure modes. | If regulated or support-critical: at least 1 scenario for the audit/support hook. |
| 8 | **Operational Monitoring & Alertability** | A feature in production without monitoring is invisible when it breaks. | Production-bound features: scenarios verifying the relevant metrics/alerts fire correctly. |
| 9 | **Performance Expectations** | SLAs and volume implications need verification. | If SLA or volume implied: at least 1 scenario verifying the relevant threshold. |
| 10 | **Backwards Compatibility & Change Safety** | Existing users' workflows must not break silently. | If existing users impacted: at least 1 scenario verifying the prior behaviour still works for the unmigrated path. |

## Optional Categories (add when relevant)

Add these when the feature's domain calls for them. They are not mandatory.

| Category | When to add | Coverage obligation |
|----------|-------------|---------------------|
| **Internationalisation (i18n)** | Feature renders user-facing strings, dates, currencies | Scenarios verifying locale-appropriate output |
| **Payments / Money** | Feature touches money | Scenarios for rounding, currency conversion, idempotency, refund paths |
| **Migration / Data Backfill** | Feature requires schema/data migration | Scenarios for migration up/down, dual-write windows, rollback safety |
| **Rate Limiting** | Feature exposes a rate-limitable endpoint | Scenarios verifying limit, burst, recovery |
| **Accessibility** | Feature has UI components | WCAG-relevant scenarios (keyboard nav, screen reader, contrast) |
| **Multi-Tenant Isolation** | Feature runs in a multi-tenant context | Scenarios verifying tenant-boundary enforcement |
| **Disaster Recovery** | Feature is mission-critical | Scenarios verifying behaviour under partial outage, failover, recovery |
| **Concurrency** | Feature has concurrent access patterns | Scenarios for race conditions, lock contention, eventual ordering |
| **Caching** | Feature uses caching | Scenarios for cache hit/miss, invalidation, staleness windows |
| **Observability** | Feature emits logs/traces/metrics | Scenarios verifying expected telemetry is emitted |

## Epistemic Assumptions

When a coverage category depends on an unknown (e.g., "the customer's auth provider supports refresh tokens — to be confirmed"), capture it as an Assumption with 2-3 Options:

```
**Assumption A1:** Auth provider supports refresh tokens.
  Option A1.a — Refresh-token-based renewal. Coverage adds: scenario for token refresh, scenario for refresh failure.
  Option A1.b — Re-auth on token expiry. Coverage adds: scenario for re-auth prompt, scenario for re-auth cancel.
  Option A1.c — Long-lived tokens (no renewal). Coverage adds: scenario for token expiry handling.
```

Scenarios derived from an Assumption Option are tagged `@ASSUMPTION:A1.a` in `scenarios.gherkin`.

## Coverage Checklist Format

After constructing the Category Map, produce a Coverage Checklist that Stage 6 can mechanically satisfy:

| Category | Min scenarios | Must include | Notes / assumptions |
|----------|---------------|--------------|---------------------|
| Build & Quality Gates | 4 | BUILD-1..4 | BUILD-5 if Figma |
| Delivery | 1 | Promotion happy path | — |
| Core Business | 3 | S1 (happy), S2 (alt), S3 (decline) | per Verification Intent |
| Negative Paths | 2 | Validation error, dependency failure | — |
| Permissions | 2 | Admin-allow, viewer-deny | role boundary |
| ... | ... | ... | ... |
