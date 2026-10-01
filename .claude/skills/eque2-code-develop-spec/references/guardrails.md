# Guardrails

Hard limits — not suggestions. Read in full before acting.

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

- Maximum 3 fix-and-retry iterations for any single issue. After 3 failed attempts, stop and report results.
- Never set bash timeout above 180000ms (3 minutes) for any single command.
- If a command produces zero output for >120 seconds, kill it and report as failed.
