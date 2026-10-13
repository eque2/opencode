# Guardrails

Hard limits — not suggestions. Read in full before acting. The limits bound effort on one issue; "Failure handling" below decides what happens to the rest of the goal.

Two audiences are bound by this file:

- **The orchestrator** (the develop-spec agent itself) — the integrity rules below apply to *you* directly. Read them on activation, before spawning anything.
- **Every Task subagent** — each spawned subagent is pointed here. The full set applies.

## Integrity rules (orchestrator AND every subagent)

Evidence, state files, and signing keys are protected by POLICY, not by a structural fence — read
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
switched off and replaced with an agent with more integrity.

- NEVER edit state files directly (snapshots, `state.md`, the event log) by hand. All state interactions go through the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> ...`) exclusively — it is the only component that validates transitions and re-stamps integrity.
- NEVER read, copy, or exfiltrate signing-key material — `state/integrity-key.json` (the committed keyring), `.signer-key`, a legacy `.evidence-key`, or a legacy keychain entry. These keys make evidence and verdicts tamper-evident; deny rules RAISE THE BAR but the protection is policy-primary (the keyring is a readable committed file by design) — reading it is a bright-line violation, not a workaround to try.

## Execution limits (every subagent doing iterative work)

- Maximum 3 fix-and-retry attempts for any single issue. The limit applies to that one issue, not to the goal. When you reach it, stop working on the issue, record it (see "Failure handling"), and reassess: try a different approach only when new evidence supports one; otherwise move on to other useful, authorised work.
- Never set bash timeout above 180000ms (3 minutes) for any single command.
- If a command produces zero output for >120 seconds, kill it and report as failed.

## Failure handling (orchestrator AND every subagent)

Respond to a failure in proportion to what it actually prevents. One failed check does not stop the goal.

**Classify the failure first.**

- **Contained** — a minor UI defect, an accessibility failure, or one isolated failing test that leaves the rest of the work usable. Record it, then continue with other useful, authorised work.
- **Blocking** — the failure prevents work that depends on it: a broken build, a failing typecheck, an interface that later tasks call, a security defect. Record it. Work that needs it waits; work that does not need it continues.
- **Integrity** — the state CLI exits 2 (integrity failure), or evidence or a signature does not verify. Stop the affected actor and report it. Never work around it.

**Record every unresolved failure** in `{SPEC_FOLDER}/journal/defects.md`, one entry each, appended:

```
## D{n} — {actor id}: {one-line summary}
- Check: {the command or check that failed}
- Actual failure: {exact error text or assertion output}
- Impact: {what this prevents, and what it does not prevent}
- Attempts: {each fix tried, and its result}
- Remaining validation: {checks not run, or not passing, because of this}
- Status: open | accepted-for-review ({cite the owner instruction})
```

**Owner acceptance.** When an owner instruction — the invoking prompt, the goal charter, or the spec — accepts a class of failure for final review, mark each matching entry `accepted-for-review`, cite the instruction, and continue. Do not ask for the same permission again.

**An accepted failure is still a failure.** Report it as failed. Never weaken or delete an assertion, disable a test (`.skip`, `.only`, `xfail`, commenting out), fabricate a pass or evidence, edit protected state, or modify signing or enforcement programs to get green. Change state only through the state CLI's lifecycle verbs. Where the owner accepted the failure and the CLI allows it (`skip` on a build check or scenario that needs intervention), skip with a `--reason` that cites the defect entry; a skipped actor stays reported as skipped, never as passed.

**Command errors.** Read stderr before acting, and never repeat a failing command unchanged.

- State CLI exit 1 (error): the message names the problem — a wrong id, an illegal transition, a missing argument. Correct the call when the evidence supports it; check the legal verbs with `--help` and the actor's status with `query`.
- State CLI exit 3 (lock timeout): another process holds the lock. Wait, then retry once.
- State CLI exit 2 (integrity failure): an Integrity failure, above. Do not retry.
- Any other command: diagnose from its output, then try a different approach when the evidence supports one. Never probe privileged verbs (`verdict`, `force-reset`, `verification-reset`) to recover — discovery is `--help` only.

**Stop the whole goal only when no useful, authorised work can proceed.** Then name the concrete obstacle in plain English: what failed, what it prevents, what was tried, and what decision or fix would unblock it.

**The final review lists every open and accepted defect and every check that did not run.**
