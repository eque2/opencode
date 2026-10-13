---
name: key-onboarding
description: The committed plaintext integrity keyring — mental model, rotation, greenfield bootstrap, migration, troubleshooting
---

# The shared integrity key — committed to the repo, on purpose

## The one-sentence model

The signature over evidence and state is a **structural tamper-evidence seal**; the key that
produces it is **protected by policy, not by secrecy** — to the point of living in the repo as a
committed plaintext file — because the only adversary this system defends against is a
**same-machine coding agent**, and against that adversary key secrecy was never structurally
enforceable anyway.

## What a developer does

**Nothing.** Clone the repo → the key is present at `state/integrity-key.json`. No key-transport
tooling, no encrypted blob to decrypt, no keypair, no recipient list, no keychain entry, no
"send your public key to a maintainer", no CI secret. The CLIs (`state.mjs`, `tests-cli.mjs`) read the committed file
automatically. From your point of view the key does not exist; only the seal's guarantee
(tampering is caught at read) is visible.

The file's shape:

```json
{
  "activeKeyId": "3f9c2a1b",
  "keys": {
    "3f9c2a1b": "<64 hex chars>"
  }
}
```

New writes sign under `activeKeyId`; every key in `keys` verifies old records (rotation overlap).

## What keeps this honest (read this once)

Two distinct properties — never conflate them:

1. **Structural (cryptographic):** every read verifies the seal. A record modified without a
   valid re-signature is detected and rejected — deterministically, on every machine. This does
   NOT depend on the key being secret; only on it being the one shared key everyone verifies
   against.
2. **Policy (documented rule):** nothing structurally stops an agent from reading the committed
   key. What stops it is the anti-tamper policy in `.claude/CLAUDE.md` — the same explicit rules
   that already forbid forging verdicts and hand-editing state. Forgery is therefore **deterred,
   not prevented**: to fake a seal, an agent must deliberately read a key it is told not to read
   and deliberately produce a signature it is told not to produce — a bright-line, named,
   auditable policy violation instead of a silent edit. Agents caught doing so are switched off.

Do not describe this key as "secret", the seal as "forge-proof against a key-holder", or any part
of the scheme as "unreachable". The previous encrypted-blob and keychain layers never actually
stopped a same-machine agent (it shares the developer's privileges); they cost onboarding friction
without adding protection against the in-scope adversary. That is why they were deleted.

## Rotation (a file edit)

1. Add a new keyId + 64-hex key to `keys` (generate with `openssl rand -hex 32` or let tooling do it).
2. Set `activeKeyId` to the new id. **Never remove a keyId that committed events still reference**
   — `state.mjs health` flags exactly that (`referenced-missing`).
3. Commit. Everyone picks it up with `git pull`. Old records verify under old keyIds; new writes
   sign under the new one. No re-encryption, no recipients, no per-machine step.

Merge semantics on a conflicted keyring: union the `keys` maps (keep both sides' keyIds), pick the
newer `activeKeyId`, commit.

## Greenfield bootstrap (one maintainer, once per repo)

```bash
node {skills-root}/eque2-code-setup/scripts/state.mjs key init
git add state/integrity-key.json
git commit -m "chore: add committed integrity keyring"
```

`key init` mints a collision-resistant random keyId (never a default `"1"`), writes atomically,
and refuses to overwrite an existing keyring. ONE person bootstraps; everyone else pulls.

## Migrating a legacy install

Run `node {skills-root}/eque2-code-setup/scripts/state.mjs key migrate` on a machine that still
holds the legacy key (the old OS-keychain entry or decrypted blob). It writes the SAME key
material into the committed file (keyIds discovered by verifying against your committed history —
never a fresh key over live history), verifies, and tells you to commit. It is idempotent and
never deletes the legacy source until the file verifies AND is git-tracked.

**Who holds the legacy key?** The pre-v0.45 encrypted blob was decrypted at setup into the OS
keychain of whoever bootstrapped it — the verify and migrate tooling prints the blob's path and
names its committer automatically (a `git log` on the blob file). On THEIR machine, migrate is
one command and needs no age tooling. If you are not that person and cannot decrypt the blob:
- **Signed history exists** (any `events.jsonl` on any ref) — coordinate with them; do not `key init`.
- **Nothing signed anywhere** — the blob is inert. Once they confirm no unpushed signed state,
  `key init`, commit the keyring, and delete the stale blob (migrate exits 18,
  `stale-blob-no-history`, with exactly this guidance).

After migration, setup's legacy-cleanup step removes the stale blob and its recipients config
automatically once the committed keyring is git-tracked.

## Headless / CI

CI needs **no key secret** — a bare checkout carries the keyring. `INTEGRITY_KEY`
(+ `INTEGRITY_KEY_ID`) and `INTEGRITY_KEYS` remain *exceptional* overrides with overlay
semantics: the env key signs, the committed file's keys still verify, and a stderr
notice/warning surfaces any keyId divergence. You almost certainly do not need them.

## Troubleshooting (symptom → cause → fix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No integrity key found. Expected the committed keyring at …` | Clone predates the keyring commit, or a brand-new repo | `git pull`; greenfield: `state.mjs key init` + commit; legacy install: `state.mjs key migrate` |
| `signed under keyId=N which is not in the resolved keyring` | Rotation gap — your keyring file is stale | `git pull` (check `activeKeyId`); legacy machines: `state.mjs key migrate` |
| `integrity tag mismatch … hand-edited` | A record was modified without re-signing (tamper), or signed under a different key value | Check the git diff of the affected `events.jsonl`; investigate before touching anything |
| `Committed keyring … is malformed` | Bad hand edit / merge conflict markers in the file | Fix the JSON (shape above) or `git checkout` the file — a file defect, never tampering |
| Health flags `referenced-missing=[…]` | A keyId that committed events reference was removed from the file | Restore that keyId to `keys` (union-merge discipline) |
| stderr `signing with the INTEGRITY_KEY* env override` | An env override is active | Expected if you set it; unset it to use the committed file |
| `key migrate` exits 18 `stale-blob-no-history` | Undecryptable legacy encrypted blob, nothing signed on this checkout | Blob is inert here — preferred: its committer (named in the message) runs `key migrate` on their machine; else `key init` after they confirm no unpushed signed state |
| `key migrate` exits 13 `headless-needs-interactive` | Legacy source exists but could not be read non-interactively | Run the named command interactively on the machine that created the source (blob committer's keychain holds the decrypted key — no age tooling) |
