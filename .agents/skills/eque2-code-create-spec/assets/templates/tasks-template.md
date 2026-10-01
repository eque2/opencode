# Tasks: {FEATURE-ID}

## Task List

| ID | Name | Status | Supports Scenarios | Dependencies |
|----|------|--------|--------------------|--------------|
| T1 | {task name} | pending | S1, S2 | — |
| T2 | {task name} | pending | S3 | T1 |

## Task Details

### T1: {task name}

**Goal:** {What this task accomplishes}

**Depends On:** {comma-separated task IDs that must finish first, or `—` for none}

**Tests:** {test file path + optional pattern on ONE line, e.g. `test/foo.spec.ts should parse CSV`, or `test/foo.spec.ts (full suite)` to run the whole file. Never embed markdown (`**`, headers) in this line.}

**Implementation Notes:**
{Specific guidance for the build-task subagent}

**Files to Create/Modify:**
{List of files this task touches}

**Acceptance:** Scenarios {list} pass after implementation
