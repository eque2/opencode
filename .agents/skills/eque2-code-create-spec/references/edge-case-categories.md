# Edge-Case Categories for Per-Task Test Design

Used by Stage 7 (Tasks + per-task tests) for research-driven test design. Every task touching SDK/framework/library code should walk through these categories and list specific test cases for those that apply.

## The 10 Categories

### 1. Happy Path
The single most common successful interaction. The test that proves the feature does what it's supposed to.

**Example tests:**
- "given valid input X, the function returns Y"
- "given an authenticated user and a permitted action, the request succeeds with 200"

### 2. Invalid Input
The input is the wrong type, the wrong shape, or otherwise malformed. The system should reject cleanly with a meaningful error.

**Example tests:**
- "given a string where a number is expected, the function rejects with a clear type error"
- "given JSON with an unexpected field, the parser ignores it (or rejects, per contract)"

### 3. Boundary Values
At the edge of acceptable input ranges. Off-by-one issues live here.

**Example tests:**
- "given input at the minimum allowed value (e.g. 0), behaviour is correct"
- "given input one below the minimum (e.g. -1), behaviour is correct (reject)"
- "given input at the maximum allowed value, behaviour is correct"
- "given input one above the maximum, behaviour is correct (reject)"
- "given an empty array, behaviour is correct"
- "given an array of exactly one element, behaviour is correct"

### 4. Empty / Null / Undefined
The input or context is missing entirely. Different from invalid input — the slot exists but contains nothing.

**Example tests:**
- "given a null user, the function rejects without throwing"
- "given an undefined optional parameter, the default kicks in"
- "given an empty string, behaviour is correct (often: treat as missing)"

### 5. Error Propagation
A downstream call fails. The system should handle the failure correctly — retry, fall back, propagate, or convert as appropriate.

**Example tests:**
- "given the database returns a connection error, the function propagates with context"
- "given the external API returns 500, the function retries N times and then surfaces"
- "given a timeout, the function cancels and reports clearly"

### 6. Concurrency
Multiple simultaneous calls. Race conditions, lock contention, eventual consistency.

**Example tests:**
- "given two concurrent updates to the same record, the system serialises correctly"
- "given a write followed by an immediate read, the read sees the write (or doesn't, per consistency contract)"
- "given the same idempotency key submitted twice, the second is a no-op"

### 7. State Transitions
The system has multiple states; the test verifies the transition rules.

**Example tests:**
- "given a record in `pending`, marking it `complete` transitions correctly"
- "given a record in `complete`, attempting to mark it `pending` is rejected"
- "given a record in `archived`, no further transitions are allowed"

### 8. Resource Limits
Memory, CPU, network, storage, rate-limit budgets. Behaviour when the system is near or at a limit.

**Example tests:**
- "given a payload at the maximum size, the function processes correctly"
- "given a payload one byte over the maximum, the function rejects cleanly"
- "given the rate-limit budget exhausted, the function returns 429 with a Retry-After header"
- "given memory pressure, the function streams instead of buffering" *(if applicable)*

### 9. Security Boundaries
Authentication, authorisation, input sanitisation, injection prevention.

**Example tests:**
- "given an unauthenticated request, the function returns 401"
- "given an authenticated request without permission, the function returns 403"
- "given input containing SQL-like strings, the parameterised query handles them safely"
- "given input containing HTML/script tags, the renderer escapes them"
- "given a token from a different tenant, the request is rejected"

### 10. Timing
Operations that depend on time — timeouts, cache TTLs, token expiry, scheduled jobs.

**Example tests:**
- "given a token at expiry-1s, requests succeed"
- "given a token at expiry+1s, requests fail with a re-auth signal"
- "given a cached value at TTL+1s, the next read fetches fresh"
- "given a scheduled job at the boundary of a daylight-saving transition, the job runs exactly once"

## How to Use This in Task Generation

For each task, walk the 10 categories. For each category, ask:

1. **Does it apply?** Some tasks (e.g. "add a constant to a file") have no concurrency or security implications. Skip those categories.
2. **If yes, what's the specific test?** Don't say "test error handling" — say "test that a 503 from the user service surfaces as a 502 from this endpoint with the original status in the error envelope".

Categories that don't apply still get noted as N/A so a future reviewer can see they were considered, not forgotten.

## Research-Driven Discovery

The categories above are a checklist. Specific cases come from reading the SDK / framework / library documentation:

- Check the library's "Edge Cases" or "Common Pitfalls" section if it has one
- Read the library's CHANGELOG for "fixed: …" entries — these are real-world edges
- Check open GitHub issues tagged "bug" for the library — these are tomorrow's edges
- For protocol-level libraries (HTTP, WebSocket, gRPC), check the relevant RFC for boundary behaviour

Cite the source for non-obvious cases in the task's Notes section. The dev agent should be able to trace why a particular test exists.

## Output Format in tasks.md

```markdown
### T2.3 — Add idempotency guard to webhook handler

- **File:** `src/webhooks/payment.ts` (UPDATE)
- **Action:** Wrap the existing handler in an idempotency check using the webhook event ID
- **Tests:** `src/test/webhooks/verify-PROJ-123-S5.spec.ts`
- **Test Cases:**
  - Happy Path — given a new event ID, the handler processes and records the ID
  - Concurrency — given two simultaneous deliveries with the same ID, only one is processed
  - State Transitions — given an already-processed ID, the handler returns 200 without re-running the action
  - Security Boundaries — given a forged signature, the handler rejects before the idempotency check
  - Timing — given an ID older than the retention window, the handler treats it as new (per Stripe webhook docs: events older than 30 days are not redelivered)
- **Supports:** S5, BUILD-4
- **Notes:** Idempotency retention aligns with Stripe's 30-day delivery window (https://stripe.com/docs/webhooks/best-practices#idempotency). Coding standard COD-014 requires structured logging for all webhook outcomes.
```
