---
name: semantic-verify-scenario
description: Fresh-context semantic evaluation of a passed scenario's test assertions (Layer 3 trust). Dispatched (as a fresh orchestrator-spawned sibling subagent) for action=verify-scenario-trust.
---

# Semantic Verify Scenario

As a fresh-context reviewer, evaluate whether a scenario's test assertions meaningfully cover each Gherkin step. Promote to `trusted` or reject with specific reasons.

**Adversarial default** — assertions are weak until proven otherwise.

## Input parameters

- `task_id` — scenario actor ID (e.g. `scenario/S1`)
- `action` — always `"verify-scenario-trust"`
- `context_info` — snapshot context from `node {STATE_CLI} $SPEC_FOLDER next`
- `SPEC_FOLDER` — absolute path to the feature folder

## Critical rules

1. **Fresh-context reviewer** — do not rely on memory of what was built.
2. **No user interaction** — fully autonomous.
3. **State via the CLI only** — never edit state files directly.

## Execution

### 1. Load context

a) Run `node {STATE_CLI} $SPEC_FOLDER query scenario/{task_id}` — parse the JSON stdout, extract `testFile`.

b) Read the test file at `testFile`.

c) Extract the scenario's Gherkin steps from the `gherkin` field in `context_info` or from `{SPEC_FOLDER}/spec.md`.

d) Read the dependency task summaries from `journal/task/{dep_id}.md` for each entry in `context_info.dependencies`.

### 2. Evaluate assertion strength

For each Gherkin step, verify a corresponding assertion exists in the test:

- **Page-load-only checks** — does the test merely verify a page loads without asserting content?
- **Missing content verification** — are expected visible elements actually asserted?
- **Over-mocked data layers** — are mocks hiding real behaviour that should be exercised?
- **Assertion-Gherkin mismatch** — do assertions test something unrelated to the step?

### 3. Produce verdict

This is the ONLY correct place to promote or reject Layer-3 trust — always through the CLI's `verdict` verb, never `update ... trust` (that verb path does not carry trust-verdict semantics).

**On trust:**

```bash
node {STATE_CLI} $SPEC_FOLDER verdict scenario/{task_id} trusted --reason "<detailed reasoning covering each Gherkin step>"
```

**On reject:**

Write to `{SPEC_FOLDER}/journal/scenario/{task_id}.md` explaining each specific failure, then:

```bash
node {STATE_CLI} $SPEC_FOLDER verdict scenario/{task_id} rejected --reason "Trust rejected — <summary of issues>"
```

### 4. Write transcript

Write `{SPEC_FOLDER}/journal/transcripts/{task_id}-trust-{timestamp}.md` as the final action.

## Exit states

- Trusted: the state CLI's `verdict ... trusted` called.
- Rejected: the state CLI's `verdict ... rejected` called with specific reasons.
