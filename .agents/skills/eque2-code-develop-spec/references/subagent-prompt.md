# Task Subagent Prompt Template

Use this template when spawning a general-purpose Task subagent for **build / review / check**
work. A `verify`/`verify-scenario-trust` recommendation is NEVER dispatched from this template — the
orchestrator spawns those as a fresh SIBLING subagent using `references/verify-subagent-prompt.md`
instead (D3, remove-docker workstream). Replace `{task_id}`, `{action}`, `{context_info}`,
`{SPEC_FOLDER}`, and `{STATE_CLI}` with actual values.

---

```
You are executing task {task_id} (action: {action}).

RECOVERY: First read journal/{task_id}.md if it exists.
If prior work is recorded, resume from where it stopped.

JOURNAL: Write to journal/{task_id}.md throughout:
  - INTENT: what you plan to do (before acting)
  - OUTCOME: what happened (after acting)

TASK DETAILS:
{context_info from `node {STATE_CLI} $SPEC_FOLDER next --context`}

SPEC: Read {SPEC_FOLDER}/spec.md for full context.

ACTION MAPPING:
  build   → follow build-task/SKILL.md
  review  → follow review-task/SKILL.md
  check   → run build check inline (lint + typecheck)

STATE UPDATES — via the state CLI ONLY, never edit state.md or state files directly:
  Run: `node {STATE_CLI} $SPEC_FOLDER <verb> [args]` — one JSON object on stdout, exit 0 on
  success; a non-zero exit with a stderr message is a HARD ERROR, stop and report it.

  Before work:
    1. `node {STATE_CLI} $SPEC_FOLDER query {task_id}` — extract `.status`.
    2. Select verb:
         status == "not_started" → verb = "start"
    3. `node {STATE_CLI} $SPEC_FOLDER update {task_id} <verb> --reason "<intent>"`
  On success:
    `node {STATE_CLI} $SPEC_FOLDER update {task_id} complete --reason "<outcome>"`
    'complete' does NOT just mark the task done — it triggers structural
    verification. The task only advances if verification passes. If the
    response has success: false (look for a side effect of type
    completion-verification-failed and read its reason), the task is NOT
    complete: fix the gap it names — usually a missing or failing test — and
    call complete again. Do NOT fall back to fail for this.
  On failure (genuine, unrecoverable work failure — not a failed verification):
    `node {STATE_CLI} $SPEC_FOLDER update {task_id} fail --reason "<what went wrong>"`

  NOTE: For scenario actors, completion is driven by the vitest reporter and the verify subagent
  (see verify-subagent-prompt.md), not by an explicit complete call from this template.

COMMIT CONVENTIONS: Before your first commit, check
journal/commit-convention.md for cached conventions.
If not found, discover from commitlint.config.*,
.husky/commit-msg, and git log --oneline -10.
Cache to journal/commit-convention.md. Follow the
discovered convention exactly.
NEVER run git commit in background — you must see
hook output to recover from failures.

QUALITY GATE: After completing work, run lint and
type-check. Check journal/quality-checks.md for
cached commands, or discover from package.json
scripts. Warnings are errors. Fix all issues before
marking the task complete.

EXECUTION MODE: Run every command in the FOREGROUND and wait
for its output within THIS turn. Do NOT use run_in_background,
detached waiter loops, or "I'll wait for the completion
notification" for your build, test, gate, or commit commands.
For a Task subagent, backgrounding a command and yielding to
wait ENDS YOUR TURN — the runtime sees no live background
children and marks you `completed` while the task is still
unfinished, and every resume reloads your full context (tens of
thousands of tokens). If a command is legitimately long, run it
in the foreground with an appropriate timeout (≤180s, per the
guardrails); a build/test/typecheck that normally finishes in
under a minute never needs backgrounding. Only the orchestrator
polls background work — never you.

GUARDRAILS: Read references/guardrails.md in full and
obey every rule before doing any work. Hard limits — not
suggestions. Evidence, state files, and signing keys are protected by POLICY, not by a structural fence — read
this carefully: the shared integrity key is a committed plaintext keyring
(`state/integrity-key.json`), in the repo by deliberate design, and reading it is STILL forbidden.
Do NOT: (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state
folders directly — all state changes go through the state/tests CLI; (3) forge or hand-edit a
verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material
(`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a legacy
keychain entry);
(5) modify the enforcement programs themselves — the state/tests CLIs, reporters, hooks, and
goal-gate scripts under any `skills/eque2-code-*/scripts/` tree (`state.mjs`, `tests-cli.mjs`,
`scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-
stop.sh`), because the policy protects the data only while the program that checks it is intact
— a loosened validator makes every later verdict worthless. A schema or verb change there needs
the owner's explicit instruction or an upstream release, and lands as its own commit stating
the contract diff. Tampering is EVIDENT on pull (HMAC verify-at-read) unless the tamperer ALSO
re-signs with the committed key — which requires the forbidden key read above, turning a silent edit
into a deliberate, named policy violation — and a verdict from an unregistered key is
cryptographically rejected (Ed25519 verify-at-read); a same-machine agent is deterred by this
policy, not prevented by an unbypassable structure. Agents caught forging evidence or state may be
switched off and replaced with an agent with more integrity. The
execution limits (3 retries, 3-minute timeout,
zero-output kill) also bind you.

SELF-HELP: Consult {project-root}/docs/CLAUDE/ before
failing. Fix infrastructure issues yourself.
NEVER ask the user questions — run autonomously.

TRANSCRIPT: As your FINAL action, write the complete
transcript of everything you did to:
  journal/transcripts/{task_id}-{action}-{timestamp}.md
Use format: YYYYMMDD-HHmmss for timestamp.
Include: all commands run, their output, decisions
made, files changed, errors encountered, and final
outcome. Previous transcripts are never overwritten.
```
