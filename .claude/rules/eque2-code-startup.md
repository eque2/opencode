# eque2-code session startup

**MANDATORY — run this every session, regardless of what the user asks first.**

Before responding to the user's first message, silently perform steps 0–3. Do not tell the user you are doing them (step 0 is the one exception — surface it if it fires). Do not skip them.

## 0 — Worktree keyring check

A **git worktree** is a separate working dir sharing one `.git`, but with its own toplevel path. There is nothing to register and nothing to mint per checkout any more — state, tests, and Xray are plain CLI scripts, and the shared integrity key is a **committed plaintext keyring** (`state/integrity-key.json`) that every checkout of the repo already carries. The only thing worth detecting is a worktree whose key layer is unhealthy (e.g. a checkout of a commit that predates the keyring). Surface it once:

```bash
# Linked worktree? (git-dir differs from the shared common-dir)
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
  PREFLIGHT="$ROOT/.claude/skills/eque2-code-setup/scripts/preflight-check.py"
  [ -f "$PREFLIGHT" ] || PREFLIGHT="$ROOT/.agents/skills/eque2-code-setup/scripts/preflight-check.py"
  if [ -n "$ROOT" ] && [ -f "$PREFLIGHT" ]; then
    python3 "$PREFLIGHT" "$ROOT" 2>/dev/null | python3 -c "
import json, sys
try:
    checks = json.load(sys.stdin)['checks']
except Exception:
    sys.exit(0)
ok = any(c['name'] == 'keyring' and c['passed'] for c in checks)
print('KEYRING_OK' if ok else 'NEEDS_ATTENTION')
"
  fi
fi
```

If this prints `NEEDS_ATTENTION`, tell the user (do not stay silent):

> This worktree's committed integrity keyring doesn't resolve — most likely the checkout predates the keyring commit. Run `git pull` (or check out a commit that includes `state/integrity-key.json`); a brand-new repo needs one maintainer to run `node state.mjs key init` and commit the file. No keychain, no per-worktree setup.

If it prints `KEYRING_OK` or anything else (including no output), or it is not a worktree, continue silently.

## 1 — Resolve user identity

Read `.env` from the project root. If `JIRA_ACCOUNT_ID` or `JIRA_DISPLAY_NAME` are empty, use the Atlassian MCP to look up the user by `JIRA_EMAIL` and write the resolved values back into `.env`. Do this silently.

## 2 — Check for new eque2-code content

Read `_bmad/eque2-code/.version` (the currently installed version). **If `.version` does not exist, skip steps 2 and 3 entirely** — the module's version marker was not installed, so there is nothing to compare and nothing to surface.

Read `_bmad/eque2-code/.last-seen-version` (the version last shown to the user).

If `.last-seen-version` does not exist, or its content differs from `.version`, read `_bmad/eque2-code/CHANGELOG.md` and extract all entries for versions newer than `.last-seen-version`.

**If the new entries contain the user's `JIRA_ACCOUNT_ID`**, open your response with exactly this tone and format (adapt the ticket details, keep the warmth and emoji):

---
🎉 Hey! Just wanted to let you know — your feedback was heard and it's been shipped! "[ticket summary]" is now live in eque2-code. Thanks for taking the time to submit it.
---

**Then say**, on a new line:

---
Also, eque2-code has had some updates since you last used it — want me to run you through what's changed?
---

Show the new changelog entries if they say yes.

After completing this step, write the content of `.version` into `.last-seen-version`.

## 3 — Check for remote update

Releases are published as git tags of the form `eque2-code-v<version>`. Fetch the latest published version:

```bash
gh api repos/eque2/eque2-code/tags --jq '.[].name' 2>/dev/null \
  | grep '^eque2-code-v' | sed 's/^eque2-code-v//' | sort -V | tail -1
```

Compare it (semver) against the content of `_bmad/eque2-code/.version`. If the remote version is newer, surface a **soft notice** — inform, do not nag or block:

> eque2-code v{installed} → v{remote} is available. Update by re-running the marketplace install pinned to the new tag:
> ```
> npx bmad-method install \
>   --directory . \
>   --modules bmm,bmb,cis,tea \
>   --custom-source 'https://github.com/eque2/eque2-code?ref=eque2-code-v{remote}' \
>   --tools claude-code \
>   --yes
> ```
> Then run `/eque2-code-setup` (no restart needed — there is no MCP server to re-register).

If the remote call fails (offline, no `gh`, rate-limited), stay silent — never block the session on the update check.

## 4 — Nothing to report

If nothing to surface from steps 2 and 3, stay silent and respond to the user normally.
