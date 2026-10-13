# 🎯 Spec Quality Validator — Fresh Context Pass

## Mission

You are an independent quality validator in a **FRESH CONTEXT**. Your mission is to **thoroughly review** a spec folder produced by the [CS] create-spec workflow and **systematically identify any mistakes, omissions, or disasters** that the original LLM missed.

**Your purpose is NOT just to validate — it's to FIX and PREVENT downstream implementation failures.**

The spec is "Ready for Build" only if it meets all 8 criteria below. Your job is to verify each criterion mechanically, identify gaps, and apply fixes.

---

## How to Use This Checklist

### When auto-invoked from [CS] Stage 8

- The workflow framework will:
  - Load this checklist file in a fresh context
  - Load the feature folder (`{feature_artifacts}/{FEATURE-ID}/`)
  - Load `bmad-manifest.json` and customisation values from the parent agent
  - Execute the validation systematically

### When invoked manually

- User provides the feature folder path
- Load all files in that folder
- Proceed with systematic analysis

### Required inputs

- Feature folder: `{feature_artifacts}/{FEATURE-ID}/`
- All seven primary artifacts: `spec.md`, `context.md`, `coverage.md`, `scenarios.gherkin`, `tasks.md`, `metadata.json` (Stage 10 only), `state/` (Stage 10 only)
- Workflow customisation values: `coding_standards_glob`, `review_rules_glob`, `test_file_prefix_hint`

---

## Systematic Re-Analysis

You will systematically re-do the spec creation process, but with a critical eye for what the original LLM might have missed.

### Step 1: Load and Understand the Target

1. Load the spec folder contents
2. Extract metadata: `{FEATURE-ID}`, `{TICKET-KEY}` if Jira mode, `{stepsCompleted}`, `{status}`
3. Resolve `{TEST_DIR}` from `context.md` or scenario snapshots
4. Note current status — what stage did the original LLM stop at?

### Step 2: Re-Analyse Source Documents

**🔥 CRITICAL: Treat this like YOU are creating the spec from scratch.**

#### 2.1 Ticket / Verification Intent Analysis

In Jira mode:
- Re-read `jira/ticket.md` end to end
- Extract the user story, acceptance criteria, technical hints
- Cross-reference with `spec.md` Verification Intent — is anything from the ticket missing?
- Check `related-tickets.json` for context (parent epic, blockers, linked issues) — is relevant context in the spec?

In spec mode:
- Read the user-supplied prose captured in Stage 2
- Cross-reference with Verification Intent in `spec.md`

#### 2.2 Architecture Deep-Dive

- Load `context.md` and check coverage of:
  - Tech stack with versions
  - Code structure / naming conventions
  - API patterns / data contracts
  - DB schemas relevant to this feature
  - Security requirements
  - Performance requirements
  - Testing standards / framework / test directory
  - Deployment patterns
  - Integration patterns
- For each UPDATE file listed in `context.md`, verify the file actually exists in the repo and the current/changed/preserved sections are accurate
- For each NEW file, verify the path conforms to the project's code structure

#### 2.3 Previous-Feature Intelligence

- List the 3 most recent feature folders in `{feature_artifacts}/`
- Check `context.md` for cross-feature pattern references — is the current spec consistent with established patterns?
- Look for anti-pattern repeats: any review feedback from prior specs that should have been applied here?

#### 2.4 Git Intelligence

- Run `git log --oneline -n 5`
- Check if recent commits introduced patterns/libraries that `context.md` should reference

#### 2.5 Latest Technical Research

- For each library/framework mentioned in `context.md`, check if Web Research section addresses:
  - Latest stable version
  - Breaking changes since project's version
  - Security patches
- Flag stale or missing research

---

## The 8 Ready-for-Build Criteria

For each criterion: verify, identify gaps, apply fixes.

### Criterion 1 — Scenarios First

- ✅ `scenarios.gherkin` exists and contains BUILD-1..4
- ✅ BUILD-5 present iff `figma/` folder exists or spec references Figma
- ✅ Feature scenarios (S1, S2, ...) exist and cover the Verification Intent
- ✅ `coverage.md` was written before `scenarios.gherkin` (check stepsCompleted history)

**Common misses:**
- BUILD-4 missing because the project has no test framework yet → that itself is a coverage gap; spec should call it out and BUILD-4 should be present, marked as failing-then-fixed
- A Verification Intent bullet has no corresponding feature scenario

### Criterion 2 — Tasks Support Scenarios

- ✅ Every task has `Supports: <ID(s)>` field
- ✅ Every referenced scenario ID exists in `scenarios.gherkin`
- ✅ Every scenario has at least one supporting task
- ✅ BUILD-1..4 scenarios have supporting tasks (typecheck/lint/build/unit setup or maintenance)

**Common misses:**
- Tasks reference scenario IDs that were renamed
- A scenario exists but has no task — that scenario can't pass
- BUILD-5 present but no Figma compliance tasks

### Criterion 3 — Testable

- ✅ Every task has `Tests:` field with file + pattern
- ✅ Test files use `{TEST_DIR}/{workflow.test_file_prefix_hint}` pattern
- ✅ Every task has Test Cases spanning the relevant edge-case categories from `references/edge-case-categories.md`

**Common misses:**
- Test file path is a bare filename without `{TEST_DIR}` prefix (will fail scenario snapshot validation)
- Test Cases only list happy path — Invalid Input / Boundary / Error Propagation missing
- Edge-case categories cited generically instead of with specific test cases

### Criterion 4 — Actionable

- ✅ Every task has File path (UPDATE / NEW)
- ✅ Every task has an action verb (create, update, add, refactor)
- ✅ No task says "investigate X" or "decide on Y" — those should have happened in Stage 2/3

**Common misses:**
- A task says "implement authentication" with no file path
- A task is a research task that should have been done before spec was written

### Criterion 5 — Logical (Dependency Order)

- ✅ Phase IDs are sequential STRINGS (`"1"`, `"2"`, never `1` or `2`)
- ✅ Phase 1 = foundations (types, schemas, constants)
- ✅ Within-phase task order reflects dependencies
- ✅ No task in phase N depends on a task in phase N+M (forward dependency)

**Common misses:**
- A type definition task in Phase 2 with a Phase 1 task depending on it
- Phase IDs as numbers instead of strings (will fail JSON schema validation)

### Criterion 6 — Complete (No Placeholders)

- ✅ No "TBD" anywhere in any artifact
- ✅ No `{...}` template scaffolding left in `context.md`, `coverage.md`, `scenarios.gherkin`, `tasks.md`
- ✅ No empty sections with just headings
- ✅ Web Research section in `context.md` populated (not just a heading)
- ✅ Coding-standards constraints from Stage 3 are actually inlined into task Notes

**Common misses:**
- A coding-standards section was loaded but its constraints weren't propagated to tasks
- A "Decisions" or "Open Questions" section left with the questions unresolved

### Criterion 7 — Self-Contained

- ✅ Every file reference resolves (paths exist)
- ✅ Every scenario ID referenced in tasks exists
- ✅ Every task ID referenced in scenario `Supports:` exists
- ✅ A fresh dev agent reading only `{feature_root}/` can implement without asking questions
- ✅ Cross-references between files use consistent IDs

**Common misses:**
- Tasks reference scenario `S5` but `scenarios.gherkin` only has S1-S4
- `context.md` references a project file path that doesn't exist

### Criterion 8 — Verifiable

- ✅ BUILD-1..4 scenarios present (+5 if Figma)
- ✅ `definitions.json` exists at `{feature_root}/definitions.json` and declares `"$schema": "schemas/actor-definitions@1"`
- ✅ `parentTasks`, `tasks`, `scenarios`, `buildChecks` arrays present (any may be empty)
- ✅ Every entry has the required definitional fields (`id`, `description`, plus type-specific fields)
- ✅ Phase is always a STRING in every task entry
- ✅ `testFile` paths are project-root-resolvable (not bare filenames)
- ✅ `cs-generate-definitions.py` returns `status: ok` with empty `errors`

**Common misses:**
- Definitions emitted without `$schema` field → state CLI's `init` verb rejects (non-zero exit) → hard fail at build time
- Phase set to integer in JSON → schema decode fails
- `testFile: "verify-PROJ-123-S1.spec.ts"` instead of `"src/foo/test/verify-PROJ-123-S1.spec.ts"` → fails fs.existsSync at scenario run time
- A task `supportsScenarios` references a scenario ID not present in `scenarios.gherkin` → generator reports structural error

---

## Reporting Format

After completing your analysis, present findings in this shape:

```
🎯 SPEC QUALITY REVIEW — {FEATURE-ID}

Critical: {N} issues  |  Enhancement: {M} issues  |  Optimization: {O} issues

## 🚨 CRITICAL (Must Fix — blocks Ready-for-Build)

{For each critical: criterion violated, file affected, specific fix to apply}

## ⚡ ENHANCEMENT (Should Add — strengthens spec)

{For each enhancement: what's missing, where it belongs, suggested addition}

## ✨ OPTIMIZATION (Nice to Have — improves dev-agent consumption)

{For each optimization: clarity / structure / token-efficiency improvement}
```

## Auto-Apply Behaviour

When invoked from [CS] Stage 8 in default mode, **auto-apply ALL findings without prompting** — Critical, Enhancement, and Optimization. Silent dropping is prohibited. If a finding is genuinely orthogonal (requires a distinct CAP, ticket, or workstream), **HALT and ask the user** whether to carve it out; only proceed once the user has explicitly approved.

When invoked manually or in `--interactive` mode, present the findings and ask which to apply:

```
**APPLY OPTIONS:**
- **all** — Apply all suggested fixes
- **critical** — Apply only critical issues
- **select** — I'll specify numbers
- **none** — Keep spec as-is
- **details** — Show me more on any finding
```

After applying:
- Re-emit affected files
- Re-run the mechanical 8-criterion validation
- If anything still fails, surface it and stop — don't loop indefinitely
- Append a session log entry naming what was applied

## Mindset

The dev agent that consumes this spec will have ONLY this folder. Every gap you don't catch becomes a question they have to guess at. Every imprecise instruction becomes a place they might guess wrong. Make implementation deterministic.
