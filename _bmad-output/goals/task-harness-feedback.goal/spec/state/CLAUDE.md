<!-- >>> eque2-code managed (do not edit this block) >>> -->
# eque2-code state folder — anti-tamper policy

This folder is protected by POLICY, not by a structural fence. Under normal operation, nothing
may modify its contents except the state/tests CLI (`npx tsx state.ts`/`tests-cli.ts`); a
verification agent may mint a verdict via the CLI's `verdict` verb. Do NOT hand-edit
`events.jsonl`, `HEAD.json`, any file under `snapshots/`, or `signers/*.json`, and do NOT read
signing-key material — the committed plaintext keyring `state/integrity-key.json` (in the repo
by design, still off-limits to read), a spec folder's `.signer-key`, or a legacy
`.evidence-key`. Tampering is EVIDENT on pull (HMAC verify-at-read) and a verdict from an
unregistered key is cryptographically rejected (Ed25519 verify-at-read) — but a same-machine
agent is deterred by this policy, not prevented by an unbypassable structure.
<!-- <<< eque2-code managed (do not edit this block) <<< -->
