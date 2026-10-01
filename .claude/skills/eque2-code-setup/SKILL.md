---
name: "eque2-code-setup"
description: Sets up eque2-code module in a project. Use when the user requests to 'install eque2-code module', 'configure eque2-code', or 'setup eque2-code'.
---

# Module Setup

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Installs and configures a BMad module into a project. Module identity (name, code, version) comes from `./assets/module.yaml`. Collects user preferences and writes them to three files:

- **`{project-root}/_bmad/config.yaml`** — shared project config: core settings at root (e.g. `output_folder`, `document_output_language`) plus a section per module with metadata and module-specific values. User-only keys (`user_name`, `communication_language`) are **never** written here.
- **`{project-root}/_bmad/config.user.yaml`** — personal settings, gitignored by the **Ensure .gitignore Entries** step below: `user_name`, `communication_language`, and any module variable marked `user_setting: true` in `./assets/module.yaml`. These values live exclusively here.
- **`{project-root}/_bmad/module-help.csv`** — registers module capabilities for the help system.

Both config scripts use an anti-zombie pattern — existing entries for this module are removed before writing fresh ones, so stale values never persist.

`{project-root}` is a **literal token** in config values — never substitute it with an actual path. It signals to the consuming LLM that the value is relative to the project root, not the skill root.

## On Activation

1. Read `./assets/module.yaml` for module metadata and variable definitions (the `code` field is the module identifier)
2. Check if `{project-root}/_bmad/config.yaml` exists — if a section matching the module's code is already present, inform the user this is an update
3. Check for per-module configuration at `{project-root}/_bmad/eque2-code/config.yaml` and `{project-root}/_bmad/core/config.yaml`. The upstream `bmad-method` installer **always** writes config in this per-module layout; eque2-code consolidates it into a single `{project-root}/_bmad/config.yaml`. So finding per-module files here is **routine and expected on every install** — it is not an error or an "out-of-date config". If either per-module file exists, it is folded into the consolidated config and then removed. Frame it to the user accordingly — and **avoid the word "legacy"**, which makes a normal re-consolidation sound like a problem:
   - If `{project-root}/_bmad/config.yaml` does **not** yet have a section for this module: tell the user plainly that the installer's per-module config was picked up and is being consolidated into `_bmad/config.yaml`.
   - If `{project-root}/_bmad/config.yaml` **already** has a section for this module: the installer re-wrote its per-module config on this (re)install, so you are **re-consolidating** it. Reassure the user this is normal on every update — their existing consolidated settings are kept, and the per-module values are used only as fallback defaults. Don't imply anything is wrong or outdated.
   - In both cases, per-module config files and directories are cleaned up after setup.

If the user provides arguments (e.g. `accept all defaults`, `--headless`, or inline values like `user name is BMad, I speak Swahili`), map any provided values to config keys, use defaults for the rest, and skip interactive prompting. Still display the full confirmation summary at the end.

## Detect Runtime Target

eque2-code installs on two runtimes — separately or together — and several later steps branch on which mode this is:

- **claude-code** — skills installed at `{project-root}/.claude/skills/`; Claude-specific surfaces (`.claude/settings.json` deny rules, `.claude/CLAUDE.md` clause, `.claude/rules/` startup rule) are written.
- **codex** — skills installed at `{project-root}/.agents/skills/`; **no** `.claude/` files are written — the discovery/policy surface is a managed block merged into the repo's `AGENTS.md`.
- **dual** — both roots populated (`npx bmad-method install --tools claude-code,codex`); **both** surface sets are written: all Claude surfaces AND the `AGENTS.md` managed block. The two are independent — the anti-tamper clause simply exists in both `CLAUDE.md` and `AGENTS.md` (same pinned text). `SETUP_DIR` operations (pnpm install, key verify, CLI checks) run against the `.claude/skills` copy; the payloads are identical and the CLIs are cwd-based, so either agent may execute from either root.

Detection is structural — which skills root(s) contain `eque2-code-setup/`. Every shell block below re-derives it with this exact resolver (so each block stays standalone-safe):

```bash
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
```

If **neither** root contains `eque2-code-setup/`, stop and tell the user the skill payload is missing — re-run the marketplace install.

## Check Jira Credentials (optional — advisory)

**Run this early, then continue regardless of the result.** Jira credentials are **optional**. They unlock the Jira-sourced workflows — [JF] Jira Fetch, and [ET]/Xray E2E generation, which authenticate to Jira **directly** with `JIRA_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` from the project's `.env`. But they are **not** required to install eque2-code, launch Linus, or spec from a plain prose/prompt file: `CS @brief.md` runs end-to-end without ever touching Jira. So this check reports; it does not gate.

This check is deterministic on purpose: a script decides, not the agent. It runs no network calls (so it never flakes on an offline install) — it confirms whether the three credentials are present, non-empty, and minimally well-formed in `.env`, and always exits 0.

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
python3 "$SETUP_DIR/scripts/verify-jira-credentials.py" "$PROJECT_ROOT"
```

The script always exits 0. Surface its output, then **continue to Collect Configuration** either way:

- **Credentials present** — note that Jira-sourced workflows ([JF], [ET]) are available, and proceed.
- **Credentials missing/incomplete** — surface the script's advisory verbatim (it tells the user what to add to enable Jira-sourced workflows), then proceed with the install. The user can add credentials and re-run `/eque2-code-setup` later to enable [JF]/[ET]; nothing else is blocked.
- Do **not** offer the Atlassian MCP (`mcp__atlassian__*`) as a credential substitute. When a Jira-sourced workflow *does* run it authenticates directly, and [JF] forbids the MCP fallback — but a missing credential set no longer stops anything here.

## Collect Configuration

Ask the user for values. Show defaults in brackets. Present all values together so the user can respond once with only the values they want to change (e.g. "change language to Swahili, rest are fine"). Never tell the user to "press enter" or "leave blank" — in a chat interface they must type something to respond.

**Default priority** (highest wins): existing new config values > legacy config values > `./assets/module.yaml` defaults. When legacy configs exist, read them and use matching values as defaults instead of `module.yaml` defaults. Only keys that match the current schema are carried forward — changed or removed keys are ignored.

**Core config** (only if no core keys exist yet): `user_name` (default: BMad), `communication_language` and `document_output_language` (default: English — ask as a single language question, both keys get the same answer), `output_folder` (default: `{project-root}/_bmad-output`). Of these, `user_name` and `communication_language` are written exclusively to `config.user.yaml`. The rest go to `config.yaml` at root and are shared across all modules.

**Module config**: Read each variable in `./assets/module.yaml` that has a `prompt` field. Ask using that prompt with its default value (or legacy value if available).

## Write Files

Write a temp JSON file with the collected answers structured as `{"core": {...}, "module": {...}}` (omit `core` if it already exists). Then run both scripts — they can run in parallel since they write to different files.

**Path arguments must be resolved, not literal.** `--config-path`, `--user-config-path`, `--target`, and `--legacy-dir` are real filesystem paths — the scripts do **not** expand the `{project-root}` token. The harness cwd may be the skill directory, so a literal `{project-root}/...` resolves relative and silently creates a stray `{project-root}/_bmad/...` tree under the skill dir (the scripts still exit 0). Substitute the actual absolute project root first — using the same `PROJECT_ROOT` guard as the CLI-install step below — and pass `$PROJECT_ROOT/...` paths. (This is distinct from `{project-root}` inside config *values*, which stays a literal token per the note above.)

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
python3 ./scripts/merge-config.py --config-path "$PROJECT_ROOT/_bmad/config.yaml" --user-config-path "$PROJECT_ROOT/_bmad/config.user.yaml" --module-yaml ./assets/module.yaml --answers {temp-file} --legacy-dir "$PROJECT_ROOT/_bmad"
python3 ./scripts/merge-help-csv.py --target "$PROJECT_ROOT/_bmad/module-help.csv" --source ./assets/module-help.csv --legacy-dir "$PROJECT_ROOT/_bmad" --module-code eque2-code
# Also register into the catalog `bmad-help` actually reads. bmad-help hard-codes
# its data source as _bmad/_config/bmad-help.csv; the write above lands in
# module-help.csv, which bmad-help never reads. Anti-zombie keyed on eque2-code,
# so base-module rows in a pre-existing catalog are preserved; the file is
# created (canonical header) if absent.
python3 ./scripts/merge-help-csv.py --target "$PROJECT_ROOT/_bmad/_config/bmad-help.csv" --source ./assets/module-help.csv --module-code eque2-code
```

All three scripts output JSON to stdout with results. If any exits non-zero, surface the error and stop. The scripts automatically read legacy config values as fallback defaults, then delete the legacy files after a successful merge. Check `legacy_configs_deleted` and `legacy_csvs_deleted` in the output to confirm cleanup.

In the setup summary, report from the second merge's JSON: the catalog path written (`_bmad/_config/bmad-help.csv`), the eque2-code row count merged (`rows_added`), and whether the catalog pre-existed (`target_existed`). Also note: **re-run `/eque2-code-setup` after any base BMad reinstall** — a base reassembly that rewrites `_bmad/_config/bmad-help.csv` drops eque2-code's rows until setup re-merges them (the re-merge is anti-zombie and idempotent).

Run `./scripts/merge-config.py --help` or `./scripts/merge-help-csv.py --help` for full usage.

## Create Output Directories

After writing config, create any output directories that were configured. For filesystem operations only (such as creating directories), resolve the `{project-root}` token to the actual project root and create each path-type value from `config.yaml` that does not yet exist — this includes `output_folder` and any module variable whose value starts with `{project-root}/`. The paths stored in the config files must continue to use the literal `{project-root}` token; only the directories on disk should use the resolved paths. Use `mkdir -p` or equivalent to create the full path.

## Ensure .gitignore Entries

eque2-code writes two classes of file into the target repo, and they must be treated oppositely:

- **Shared (committed, all developers)** — Linus's sanctum `_bmad/_memory/linus-sidecar/` (PERSONA, CREED, BOND, MEMORY, CAPABILITIES, INDEX, PULSE, `state.md`, `sessions/`), generated docs (`docs/CLAUDE/…`, `.github/review-rules/`), and `_bmad/config.yaml`. Git tracks these by default — they need **no** ignore entry.
- **Personal / runtime (never committed)** — `_bmad/config.user.yaml` (personal settings), `.state-events.jsonl` (runtime audit log), `.signer-key` (per-spec verdict signing key — plaintext, policy-protected), and `.evidence-key` (LEGACY per-spec key; no longer created, ignored for hygiene on older folders). These **must** be ignored. The committed keyring `state/integrity-key.json` is the OPPOSITE class — committed and shared by design.

This step writes ignore lines only for the personal/runtime class, inside a clearly delimited managed block, into the target repo's **root** `.gitignore`. It is idempotent — the block is rewritten in place on re-runs, never duplicated, and content outside the block is left untouched.

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
python3 "$SETUP_DIR/scripts/ensure-gitignore.py" --gitignore "$PROJECT_ROOT/.gitignore"
```

The script outputs JSON (`changed`, `action`, `entries`). If it exits non-zero, surface the error and stop.

Then check that the operator's **existing** ignore rules are not accidentally hiding any of the shared files (the script never adds negations, to avoid silently overriding a deliberate operator choice). `git check-ignore` matches patterns even for paths that don't exist yet:

```bash
git -C "$PROJECT_ROOT" check-ignore \
  _bmad/_memory/linus-sidecar _bmad/config.yaml docs/CLAUDE .github/review-rules \
  state/integrity-key.json 2>/dev/null
```

If this prints **anything**, the target repo already ignores a path that eque2-code expects to be committed and shared — `state/integrity-key.json` especially: an ignored keyring never reaches teammates and every fresh clone hard-fails. Warn the user explicitly, naming the matched path(s), and tell them they'll need a negation entry (e.g. `!_bmad/_memory/linus-sidecar/`) or to narrow the offending rule — otherwise the agent's shared memory and generated docs won't reach their teammates. If it prints nothing, say nothing.

## Install AI PR-Review GitHub Actions

Installs the Claude Code PR-review workflows (with their prompts, scripts, and composite actions) into the target repo's `.github/`, on every runtime. They review each PR against the rule files in `.github/review-rules/` — the same rules `eque2-code-review` applies locally.

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
python3 "$SETUP_DIR/scripts/install-github-review.py" --project-root "$PROJECT_ROOT"
```

The script prints JSON (`installed`, `updated`, `unchanged`, `kept`). A file the team has edited is **kept**, never overwritten — keep those paths for the Confirm step. If the script exits non-zero, surface the error and continue; the review Actions are not needed for the rest of setup.

## Install eque2-code CLI scripts

State, tests, and Xray operations are plain Node CLI scripts — `state.mjs`, `tests-cli.mjs`,
`xray-cli.mjs` — shipped bundled with this skill (no server, no daemon, no Docker; D6). This step
resolves paths, verifies the committed integrity keyring (the key rides with the clone — no
per-machine provisioning), and cleans up any stale MCP registrations / Docker artifacts left by a
prior Dockerized install of this same project.

### 0. Resolve paths (run first, reuse in every step below)

Substitute the actual project-root absolute path for `{project-root}` once, define the skill
directory, then reuse the shell variables in every later step. Every snippet that follows assumes
these are set.

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
MODULE_VERSION="$(grep -E '^module_version:' "$SETUP_DIR/assets/module.yaml" | head -1 | cut -d: -f2-)"
MODULE_VERSION="${MODULE_VERSION%%#*}"            # strip any inline comment
MODULE_VERSION="${MODULE_VERSION//[\"\' ]/}"      # strip quotes and whitespace
```

Do **not** use `./` paths, `$PWD`, or the `{project-root}` token in any shell snippet from this point on — the harness cwd may be the skill directory and those forms break asymmetrically. The absolute-path guard catches the case where `{project-root}` was passed through unsubstituted.

### 1. Install skill-local tooling

```bash
if [[ ! -x "$SETUP_DIR/node_modules/.bin/tsx" ]]; then
  pnpm --dir "$SETUP_DIR" --ignore-workspace install
fi
```

`--ignore-workspace` is required: if the operator's project (or any parent directory) declares a `pnpm-workspace.yaml`, pnpm will otherwise refuse to treat the skill directory as an independent install — even with `--dir`. The flag tells pnpm to ignore the surrounding workspace and treat `$SETUP_DIR/package.json` as a standalone manifest.

`tsx` (runs `verify-integrity-key.ts` below) is declared as a `devDependency` in `$SETUP_DIR/package.json` and ships with the skill. `pnpm --dir "$SETUP_DIR" install` resolves it into `$SETUP_DIR/node_modules/` — never into the operator's project root.

There is **no per-machine key bootstrap step any more**: the old `eque2-code-state` keychain master key (K1) was a vestige of the removed encrypted-SQLite store, and the shared integrity key now lives in the repo itself (step 2 verifies it). Existing `eque2-code-state` keychain entries on developer machines are simply ignored — nothing reads them; delete them at leisure.

### 2. Verify the committed integrity keyring

> **New in v0.45.** State is human-readable, HMAC-signed plaintext (`state/events.jsonl`)
> committed to git — and so is the key that signs it. The shared integrity keyring lives at
> **`$PROJECT_ROOT/state/integrity-key.json`, committed in PLAINTEXT by design**: the only
> in-scope adversary is a same-machine coding agent, against which key secrecy was never
> structurally enforceable. The key is protected by the same agent-facing anti-tamper POLICY
> that protects evidence and state (deterrence, not prevention — a forged seal is a bright-line,
> named policy violation), while hand-edited state/evidence is still structurally rejected at
> read. There is **nothing to fetch, decrypt, or install** — the key rides with every clone.
> The model, rotation playbook, and troubleshooting table live in
> **[`references/key-onboarding.md`](./references/key-onboarding.md)**.

Verify the key layer end-to-end (resolves the keyring, signs + verifies a probe record, and
re-verifies every committed event log under it):

```bash
"$SETUP_DIR/node_modules/.bin/tsx" "$SETUP_DIR/scripts/verify-integrity-key.ts" --project-root "$PROJECT_ROOT"
```

Branch on the result, narrating ✅/❌ plainly:

- **✅ verified** — the key layer is healthy; continue.
- **❌ keyring absent but committed signed history exists** — a broken clone: the keyring commit
  is missing. Fix: `git pull` (the maintainer's keyring commit), or — for a legacy install whose
  key still lives in an old keychain/env — run `node "$SETUP_DIR/scripts/state.mjs" key migrate`
  on the key-holding machine and commit the file it writes.
- **❌ keyring absent and NO committed history (a brand-new repo)** — greenfield bootstrap: run
  `node "$SETUP_DIR/scripts/state.mjs" key init`, then commit `state/integrity-key.json` as the
  printed instruction says. ONE maintainer bootstraps; everyone else just pulls.
  **Exception — a legacy encrypted key blob exists** (from a pre-v0.45 install; the verify script
  prints its path): the repo is NOT plainly greenfield — a team key already exists, held decrypted
  in the blob committer's OS keychain. The verify script names the committer and sweeps all fetched refs;
  relay its guidance verbatim: preferred, that person runs `key migrate` on their machine (one
  command, no age tooling); fallback, once they confirm no unpushed signed state, `key init` and
  delete the blob in a follow-up commit noting it is superseded. Do NOT ask the user to choose
  blind — the script's output names who to coordinate with.
- **❌ rotation gap** (`signed under keyId=N which the keyring does not hold`) — `git pull` to
  fetch the rotated keyring; never re-init over live history.

**Rotation** is a plain file edit: add a new keyId to `keys`, bump `activeKeyId`, commit — old
records verify under old keyIds, new writes sign under the new one, distributed by `git pull`.

> **Headless / CI path.** CI needs **NO key secret** — the committed file IS the key, so a bare
> checkout verifies and signs out of the box. `INTEGRITY_KEY` (+ optional `INTEGRITY_KEY_ID`)
> remains an *exceptional* override with overlay semantics: the env key signs, the committed
> file's keys still verify, and a stderr notice/warning surfaces the divergence.

### 3. Migrate a prior Dockerized install (idempotent, safe on a fresh install)

If this project was previously set up before Docker/MCP removal, stale MCP registrations
(`eque2-code-state`, `eque2-tests`, `eque2-xray`) and Docker artifacts (the `eque2-state:v*` image,
the `eque2-state-<hash>`/`eque2-tests-<hash>` volumes) may still exist. Run the migration script —
it is a no-op on a fresh install with nothing to clean up:

```bash
python3 "$SETUP_DIR/scripts/migrate-remove-docker.py" \
  --project-root "$PROJECT_ROOT" \
  --specs-root "$FEATURES_PATH" \
  --state-cli "$SETUP_DIR/scripts/state.mjs"
```

Where `$FEATURES_PATH` is resolved the same way step 4 (below) resolves it. The script:

1. Removes the 3 stale MCP registrations at both `--scope local` and `--scope user` (harmless if
   absent).
2. Before touching anything Docker-related, verifies every spec folder's committed `events.jsonl`
   still cryptographically verifies. If verification fails for ANY folder, the script ABORTS before
   touching Docker and prints which folder(s) failed — investigate before re-running, do not force
   through.
3. Only if verification passes (or no spec folders exist yet): removes the `eque2-state:v*` image(s)
   and the per-project Docker volumes.
4. **Never touches OS keychain entries** (the legacy `eque2-code-state` / `eque2-code-integrity`
   services) — they are no longer read by anything, but this script leaves them alone; `state.mjs
   key migrate` is the sanctioned way to move a legacy key into the committed file.
5. Sweeps stale legacy encrypted-key artifacts (the pre-v0.45 encrypted blob and its recipients
   config) — but ONLY when the committed keyring exists AND is git-tracked, i.e. the key
   migration demonstrably completed; otherwise the blob is the sole encrypted copy of the legacy
   key and is left alone. Deletions are working-tree only: if `legacyKeyArtifactsRemoved` is
   non-empty, tell the user to commit the deletion(s).

If the script reports `"aborted": true`, surface its `warnings` to the user verbatim and stop —
do not proceed with the rest of setup until the flagged spec folder's state is investigated.

### 4. Verify the CLI scripts resolve

Resolve the features path (same `feature_artifacts` config value the old writable-mount step used —
kept because the CLI, like the removed container, still needs to know where to write
`state.md`/`events.jsonl`):

```bash
FEATURES_PATH="$(EQUE2_CFG="$PROJECT_ROOT/_bmad/config.yaml" \
                 EQUE2_MODULE="eque2-code" \
                 EQUE2_ROOT="$PROJECT_ROOT" \
                 python3 -c "
import os, sys, yaml
cfg_path = os.environ['EQUE2_CFG']
module_key = os.environ['EQUE2_MODULE']
with open(cfg_path) as f:
    cfg = yaml.safe_load(f) or {}
module_section = cfg.get(module_key) or {}
val = module_section.get('feature_artifacts')
if not val:
    sys.exit(f\"feature_artifacts missing from {cfg_path} under '{module_key}' — re-run the config merge step.\")
token = '{' + 'project-root' + '}'
val = str(val).replace(token, os.environ['EQUE2_ROOT'])
if token in val:
    sys.exit('unresolved project-root token in feature_artifacts. Aborting install.')
print(val)
")" || exit 1
mkdir -p "$FEATURES_PATH"
```

Confirm the shipped CLI actually runs, offline, with no network and no Docker:

```bash
node "$SETUP_DIR/scripts/state.mjs" --help
```

If the bundled `.mjs` is not present in this install, the skill payload is incomplete — re-run the
marketplace install rather than hunting for a TypeScript source (target repos ship only the compiled
`.mjs`; `npx tsx` is never the right invocation and is known to hang in some environments).

**Dual install only — check that both copies of the skill match.** When both `.claude/skills/eque2-code-setup` and `.agents/skills/eque2-code-setup` exist, every file in the two copies must be byte-identical — the CLI bundles, the scripts, and the schemas (the create-spec scripts read the scenario id grammar from `schemas/actor-definitions.v1.schema.json`). They come from one installer payload. A drifted copy routes scenario evidence differently depending on which agent runs the tests. The block is standalone: it re-derives the variables it uses.

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
if [ "$RUNTIME" = "dual" ]; then
  python3 "$SETUP_DIR/scripts/bundle-parity-check.py" "$PROJECT_ROOT"
fi
```

The script prints JSON and always exits 0, so a drift report never aborts the setup; read its `status`. If it is `"drift"`, tell the user which files differ (the `drift` and `onlyIn` fields, and `reason`) and tell them to re-run the marketplace install with `--tools claude-code,codex`, so both copies come from one payload. Do not copy one file over the other by hand. `node_modules/` and `__pycache__/` are ignored, because setup writes them into one copy only.

A working `--help` output (not an error) confirms the Docker-less install path is functional. There
is no MCP server to register and no `claude mcp add` to run — the CLI is invoked directly by
whichever workflow needs it (`node scripts/state.mjs <verb> --specFolder=<path> ...`).

**Xray** (for the `[ET]` e2e-test workflow) works the same way — `xray-cli.mjs`, no MCP registration.
It reads Xray credentials from the project `.env` (`XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`,
`XRAY_PROJECT_ID`, `XRAY_BASE_URL`, `XRAY_OUTPUT_DIR`) exactly as the old MCP server did — not a hard
prerequisite; a repo that never authors E2E tests needs none.

**Offer to discover `XRAY_PROJECT_ID`.** `XRAY_PROJECT_ID` is the *numeric* project id, which is not
shown in the Jira UI URL. If it is missing from `.env`, offer to resolve it for the user. Ask them to
paste the Jira project URL, e.g.:

```text
https://eque2.atlassian.net/projects/CMC?selectedItem=...#!page=test-repository&selectedFolder=697b682bda48329b9b64791b
```

Then:

1. Extract the project **key** from the `/projects/<KEY>` segment (here `CMC`).
2. Resolve the numeric id via the Atlassian API — use the Atlassian MCP where available, otherwise:
   `GET https://eque2.atlassian.net/rest/api/3/project/<KEY>` → read the `"id"` field (CMC → `10018`).
3. Write `XRAY_PROJECT_ID=<id>` into the project `.env`.

Note: any `selectedFolder=…` in such URLs is the Xray **test-repository folder id**, not a project id
— different thing; don't confuse the two.

**Tests CLI** (`tests-cli.mjs`, for Grace's `[AT]`/`[BK]`/`[US]`/`[RP]` test-backfill lifecycle) is
invoked the same way — `node scripts/tests-cli.mjs <verb> ...`. Verification-run artifacts
(Playwright `trace.zip`, screenshots, stdout/stderr) are written directly to a host path
(`EQUE2_TESTS_LOG_DIR`, default `<project>/.eque2-tests/runs`, overridable in `.env`) — no
bind-mount needed since there is no container. Consider adding `.eque2-tests/` to the project's
`.gitignore`.

**Secret deny rules (policy-primary key protection) — `claude-code` runtime only.** Several
files/values a coding agent could read to forge evidence or a verdict — the committed keyring
`state/integrity-key.json` (the shared K2 signing key, committed in plaintext BY DESIGN and
protected by policy), `.signer-key` (the per-spec Ed25519 private key — a lazily-generated
plaintext file, 0600, gitignored), `.evidence-key` (legacy per-spec HMAC secret, superseded by the
committed keyring), `evidence/*.json` (per-scenario evidence an agent must not hand-edit), and
direct edits to `state/events.jsonl`/`state/HEAD.json` — `0600` file permissions alone do not stop
an agent running as the same user from reading them. Merge the deny rules covering all of them,
idempotent, safe to re-run on every `/eque2-code-setup`:

```bash
if [ "$RUNTIME" != "codex" ]; then   # claude-code and dual
  python3 "$SETUP_DIR/scripts/merge-deny-rules.py" "$PROJECT_ROOT/.claude/settings.json"
fi
```

**Honest limit**: these are policy-primary deny rules, not a structural fence — a determined agent
with shell access can always find an unenumerated path to the same secret (e.g. a one-off keyring
library call the Bash-pattern rules don't match). They raise the bar; they do not eliminate it.
On **codex** there is no settings-level deny mechanism at all — the anti-tamper policy is carried
solely by the `AGENTS.md` managed block below, and cryptographic verify-at-read remains the
structural backstop on both runtimes.

**Anti-tamper clause in the target repo's own instructions file.** eque2-code's guardrails/persona
surfaces already carry the pinned anti-tamper clause, but a coding agent working in THIS project
also reads the repo's own instructions file directly — merge the same clause there too, idempotent,
preserving whatever project instructions already live in that file. The surface differs by runtime:

```bash
if [ "$RUNTIME" != "codex" ]; then   # claude-code and dual
  python3 "$SETUP_DIR/scripts/merge-claude-md.py" "$PROJECT_ROOT/.claude/CLAUDE.md"
fi
if [ "$RUNTIME" != "claude-code" ]; then   # codex and dual
  python3 "$SETUP_DIR/scripts/merge-agents-md.py" "$PROJECT_ROOT/AGENTS.md" --skills-root ".agents/skills"
fi
```

On **codex**, `merge-agents-md.py` writes more than the clause: the managed block is the bridge
Codex uses to discover the module at all — it lists the installed skills (Linus, Grace, setup),
the bundled CLI invocations (`node .agents/skills/eque2-code-setup/scripts/state.mjs …`), how to
resolve the `{skills-root}` token, and the anti-tamper policy. Existing `AGENTS.md` content
outside the managed block is never touched. Both scripts output JSON (`changed`, `action`,
`path`); if either exits non-zero, surface the error and stop.

## Install Verifier-Only-Minting Role Separation

Only the independent verifier subagent mints test verdicts (incident CMC-32874). Three surfaces
land this in the target repo — the subagent definitions, the hooks, and the store gitignore
entries. The tests CLI's own marker/nonce gates are the load-bearing control and ship inside
`tests-cli.mjs` with no install step; everything here is point-of-action friction and role
plumbing.

**Subagent definitions** (`claude-code` and `dual` — Codex has no subagent mechanism; it uses the
runner fallback below):

```bash
if [ "$RUNTIME" != "codex" ]; then
  mkdir -p "$PROJECT_ROOT/.claude/agents"
  cp "$SETUP_DIR/assets/agents/eque2-verifier.md" "$PROJECT_ROOT/.claude/agents/eque2-verifier.md"
  cp "$SETUP_DIR/assets/agents/eque2-builder.md" "$PROJECT_ROOT/.claude/agents/eque2-builder.md"
fi
```

`eque2-verifier` is the ONLY dispatch type for verification (Grace, backfill, develop-spec all
name it); `eque2-builder` carries the unconditional mint-verb deny hook and is the dispatch type
for build subagents.

**Claude hooks** (`claude-code` and `dual`): merge the four hook registrations — SubagentStart/Stop
(matcher `eque2-verifier`) minting/revoking the role marker
(`.eque2-tests/state/.verifier-marker.json`, nonce-scoped), the session-wide marker-aware
PreToolUse guard that denies mint verbs whenever no verifier is running (the orchestrator's
friction layer), and the `Stop` goal-gate hook that refuses to end a turn while a bound goal
folder has unmet or unevidenced acceptance criteria. Idempotent; existing hooks are preserved:

```bash
if [ "$RUNTIME" != "codex" ]; then
  python3 "$SETUP_DIR/scripts/merge-hooks.py" "$PROJECT_ROOT/.claude/settings.json"
fi
```

The command audits the written Claude hook before it returns. Read
`hook_audit.status` from its JSON output. Stop setup if the status is `failed`.
Report the named source and problem. A healthy Claude result is `passed`.

**The goal gate under Codex** (`codex` and `dual`): register the gate in the project. This
registration works when Air, an IDE, or another harness gives Codex a separate `CODEX_HOME`.
The merge resolves a linked worktree to the main checkout that Codex uses for project hooks.

The project file gets only the Stop hook. It does not get the Claude verifier hooks:

```bash
if [ "$RUNTIME" != "claude-code" ]; then
  python3 "$SETUP_DIR/scripts/merge-hooks.py" --runtime codex --project-root "$PROJECT_ROOT"
fi
```

The command performs a post-merge audit. Its JSON `hook_audit` object names the
project source and each known user source. It checks the direct command, all
required gate helpers, file mode, matcher, timeout, scoped proof, duplicate
managed gates, wrappers, and owned user fallbacks. It does not change unrelated
hooks.

Handle `hook_audit.status` as follows:

- `passed` — report one canonical project gate and a valid scoped proof.
- `pending-trust` — normal, not a problem. Keep an available user fallback and
  move on. Do not ask the user to restart, trust, fire, or rerun anything, and
  do not try to prove the hook. Goals run without it: under Codex,
  `pursue-goal` skips every hook check.
- `failed` — stop setup. Report each item in `problems`. Fix the named source
  before a goal starts.

The script returns a non-zero status for `failed`. It returns zero for
`pending-trust`. A retained fallback keeps an existing loop safe.

Do not add the same gate to the user hook file during standard setup. Codex runs matching hooks
from all sources concurrently. A project hook and a user hook would run the gate twice.
The command migrates an old user hook only after the project hook has fired in that exact Codex
home. Until then, the old trusted user hook remains the safe fallback. The migration preserves
unrelated hooks, wrappers, and settings. It rejects malformed hook files without changing them.

Codex needs approval before it runs a new project hook. Nothing depends on that approval. When a
user trusts the hook in a local Codex TUI (`/hooks`), its first fire records proof for that exact
command and Codex home, and a later setup run removes the obsolete user gate for that home. Do not
prompt for this; it happens on its own or not at all.

The hook process must expose its effective `CODEX_HOME` for a scoped project proof. Air exposes
this value.

A dormant IDE home keeps its user fallback until setup runs inside that IDE. This rule prevents a
CLI upgrade from removing the last trusted Air gate. If `CODEX_HOME` is the project `.codex`
directory, migration never removes the project hook itself.

Why this matters: Codex gates hook execution on persisted trust and can skip a hook it does not
trust. A written registration is therefore not proof that the hook runs. The proof only decides
when setup may remove an old user hook. `pursue-goal` does not require it: Codex cloud can write
the registration but gives no way to trust the hook, so the hook never fires there.
Claude Code has no hook-trust layer and needs none of this.

**Store gitignore entries**: the marker and the denial log are mutable, machine-local files inside
the COMMITTED `.eque2-tests/state/` directory. The hooks self-heal a store-local `.gitignore` on
first mint, and `ensure-gitignore.py` (run earlier) covers the repo level; `preflight-check.py`'s
`marker_gitignore` check reports drift.

**Era boundary** (both runtimes): record the role-attribution era boundary NOW, not lazily at the
first mint — until it exists, a pre-upgrade binary could still mint role-absent verdicts that read
as legacy. Idempotent and protective-only (it can only tighten classification):

```bash
node "$SETUP_DIR/scripts/tests-cli.mjs" era-init
```

Skip silently only if the committed keyring does not exist yet (greenfield — the first sanctioned
mint records the boundary instead).

**Codex / hookless runtimes**: there are no hooks to install — verification dispatches through the
sanctioned runner, which mints and revokes the marker itself with identical CLI behaviour:
`python3 <skills-root>/eque2-code-setup/scripts/verification-runner.py -- <verifier command>`.
`preflight-check.py` emits an informational skip naming this fallback when no `claude` binary
exists, and fails NAMED when a claude-code runtime is older than 2.1.195 (SubagentStart agent-name
matchers).

## Cleanup Legacy Directories

After both merge scripts complete successfully, remove the installer's package directories. Skills and agents in these directories are already installed at the skills root (`.claude/skills/` or `.agents/skills/`) — the `_bmad/` directory should only contain config files.

```bash
# Stash the previously-installed version FIRST. cleanup-legacy.py removes
# _bmad/eque2-code/, and `.version` lives inside it — so the upgrade-outline step
# below can no longer read it after this point. Reading it there instead made
# EVERY upgrade look like a fresh install and silently skipped the changelog
# outline. The stash is a file, not a shell variable, because each block in this
# skill runs in its own shell.
PREV_VERSION_STASH="${TMPDIR:-/tmp}/eque2-code-prev-version"
if [ -f "$PROJECT_ROOT/_bmad/eque2-code/.version" ]; then
  tr -d '[:space:]' < "$PROJECT_ROOT/_bmad/eque2-code/.version" > "$PREV_VERSION_STASH"
else
  rm -f "$PREV_VERSION_STASH"
fi

python3 "$SETUP_DIR/scripts/cleanup-legacy.py" --bmad-dir "$PROJECT_ROOT/_bmad" --module-code eque2-code --skills-dir "$SKILLS_ROOT"
```

`_config/` is **deliberately not removed**: it holds `_bmad/_config/bmad-help.csv`, the catalog `bmad-help` reads (for every module, not just eque2-code). Wiping it was a global-help regression. The merge step above writes eque2-code's rows into that catalog, so it must survive cleanup.

The script verifies that every skill in the legacy directories exists at the skills root before removing anything. If the script exits non-zero, surface the error and stop. Missing directories (already cleaned by a prior run) are not errors — the script is idempotent.

Check `directories_removed` and `files_removed_count` in the JSON output for the confirmation step. Run `python3 "$SETUP_DIR/scripts/cleanup-legacy.py" --help` for full usage.

## Install Session Startup Rule and Outline Changes

This installs the per-session startup rule that surfaces shipped-feedback notices and a soft "newer version available" notice on every session, and — when this run is a version **upgrade** — outlines what changed right here in the install. All files are written **after** Cleanup Legacy Directories — that step removes `_bmad/eque2-code/` package contents, so the version marker and changelog must be written afterward or they would be deleted.

Four target files (the first is **claude-code only** — Codex has no `.claude/rules/` auto-load, and no `.claude/` file may be written on a codex install; the version markers and changelog are written on both runtimes so upgrade deltas are still outlined at setup time):

1. **The rule** → `$PROJECT_ROOT/.claude/rules/eque2-code-startup.md`. Files under `.claude/rules/*.md` are auto-loaded by Claude Code as project instructions, so copying it there activates it with no further wiring.
2. **The version marker** → `$PROJECT_ROOT/_bmad/eque2-code/.version`, holding the installed `module_version`. The rule reads this to detect updates; without it the rule no-ops.
3. **The changelog** → `$PROJECT_ROOT/_bmad/eque2-code/CHANGELOG.md`, copied from the skill so the rule (and the outline below) can show what changed and match shipped feedback against the user's `JIRA_ACCOUNT_ID`.
4. **The last-seen marker** → `$PROJECT_ROOT/_bmad/eque2-code/.last-seen-version`, set to the just-installed version so the session rule does **not** re-show the same changelog you outline below. The rule still fires for the *next* upgrade or a newer remote version.

The previously-installed version was already stashed by **Cleanup Legacy Directories** (that step deletes `_bmad/eque2-code/`, taking `.version` with it). Read the stash here — that delta is what drives the outline:

```bash
PROJECT_ROOT="{project-root}"   # the LLM substitutes the actual absolute path here
case "$PROJECT_ROOT" in
  /*) : ;;
  *) echo "FATAL: PROJECT_ROOT must be an absolute path — substitute {project-root} before running." >&2; exit 1 ;;
esac
SKILLS_ROOT="$PROJECT_ROOT/.claude/skills"; RUNTIME="claude-code"
[ -d "$SKILLS_ROOT/eque2-code-setup" ] || { SKILLS_ROOT="$PROJECT_ROOT/.agents/skills"; RUNTIME="codex"; }
[ "$RUNTIME" = "claude-code" ] && [ -d "$PROJECT_ROOT/.agents/skills/eque2-code-setup" ] && RUNTIME="dual"
SETUP_DIR="$SKILLS_ROOT/eque2-code-setup"
EQUE2_DIR="$PROJECT_ROOT/_bmad/eque2-code"
MODULE_VERSION="$(grep -E '^module_version:' "$SETUP_DIR/assets/module.yaml" | head -1 | cut -d: -f2-)"
MODULE_VERSION="${MODULE_VERSION%%#*}"            # strip any inline comment
MODULE_VERSION="${MODULE_VERSION//[\"\' ]/}"      # strip quotes and whitespace

# Read the stash written by Cleanup Legacy Directories, NOT `$EQUE2_DIR/.version`
# — cleanup removed that file, so reading it here always yields <none> and every
# upgrade is misreported as a fresh install.
PREV_VERSION=""
PREV_VERSION_STASH="${TMPDIR:-/tmp}/eque2-code-prev-version"
[ -f "$PREV_VERSION_STASH" ] && PREV_VERSION="$(tr -d '[:space:]' < "$PREV_VERSION_STASH")"

# DOWNGRADE DETECTION. Installing an OLDER version than the one already here is
# almost never intentional: the common cause is `npx bmad-method install` reusing
# a cached copy of the custom source instead of fetching the `?ref=` that was
# asked for, so a pinned install silently lands the previous release. Treating
# that as an ordinary "upgrade" hides it completely — the changelog delta from
# new→old is empty, so the outline prints nothing and the install looks clean.
DOWNGRADE=0
if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$MODULE_VERSION" ]; then
  OLDEST="$(printf '%s\n%s\n' "$PREV_VERSION" "$MODULE_VERSION" | sort -V | head -1)"
  [ "$OLDEST" = "$MODULE_VERSION" ] && DOWNGRADE=1
fi

mkdir -p "$EQUE2_DIR"
if [ "$RUNTIME" != "codex" ]; then   # claude-code and dual
  mkdir -p "$PROJECT_ROOT/.claude/rules"
  cp "$SETUP_DIR/assets/eque2-code-startup.md" "$PROJECT_ROOT/.claude/rules/eque2-code-startup.md"
fi
cp "$SETUP_DIR/CHANGELOG.md" "$EQUE2_DIR/CHANGELOG.md"
printf '%s' "$MODULE_VERSION" > "$EQUE2_DIR/.version"
printf '%s' "$MODULE_VERSION" > "$EQUE2_DIR/.last-seen-version"
rm -f "$PREV_VERSION_STASH"
echo "PREV_VERSION=${PREV_VERSION:-<none>} MODULE_VERSION=$MODULE_VERSION DOWNGRADE=$DOWNGRADE"
```

Then branch on the captured values:

- **Downgrade** (`DOWNGRADE=1`) — surface this LOUDLY before anything else; do not
  continue silently. Say plainly that the project previously had `PREV_VERSION` and
  this install has landed the older `MODULE_VERSION`, and that the usual cause is
  `npx bmad-method install` reusing a **cached** copy of the custom source rather
  than fetching the requested `?ref=`. Tell the user to verify against the tag they
  asked for and re-run with a cleared cache. A pinned install that quietly delivers
  the previous release is the failure this check exists to catch — an install that
  "looks clean" while shipping the wrong version is worse than one that errors.
- **Upgrade** (`PREV_VERSION` non-empty, `DOWNGRADE=0`, **and** different from `MODULE_VERSION`): read `$EQUE2_DIR/CHANGELOG.md` and outline, in `{communication_language}`, every entry for a version **newer than `PREV_VERSION`** up to and including `MODULE_VERSION`. Lead with a one-line header like "**What's new in eque2-code v{PREV_VERSION} → v{MODULE_VERSION}**", then a tight bulleted summary of each version's notable changes — not a raw paste of the file. If any of those entries reference the user's `JIRA_ACCOUNT_ID`, prepend the warm shipped-feedback line ("🎉 your feedback shipped — '[ticket summary]' is now live") before the summary.
- **Fresh install** (`PREV_VERSION` is `<none>`) or **reinstall of the same version** (`PREV_VERSION` == `MODULE_VERSION`): do **not** dump the changelog — there is no delta to outline. A brand-new user does not need the full history.

This step is idempotent: re-running overwrites the rule and changelog with the current copies and refreshes both markers.

## Confirm

Use the script JSON output to display what was written — config values set (written to `config.yaml` at root for core, module section for module values), user settings written to `config.user.yaml` (`user_keys` in result), help entries added, first-time setup vs update. If per-module installer config was folded in and removed (`legacy_configs_deleted` in the JSON), note it in one line as a **routine re-consolidation of the installer's per-module config into `_bmad/config.yaml`** — not as a "legacy migration", and without implying anything was wrong. If installer package directories were removed, report the count and list (e.g. "Cleaned up 106 installer package files from bmb/, core/, \_config/ — skills are installed at the skills root"). Also report the detected runtime (`claude-code`, `codex`, or `dual`) and, when the `AGENTS.md` block was merged (codex/dual), its merge result (`changed`/`action` from the merge-agents-md.py JSON). Report each hook audit status and its checked sources in one line. Report `pending-trust` as normal; never present it as a failure or a to-do.

No MCP roster restart is required. The state, tests, and Xray CLIs run directly.

Report the PR-review install counts (installed / updated / unchanged). Name every `kept` file and say it was left as the team edited it; to take the shipped version, delete the file and re-run setup.

Display the `module_greeting` from `./assets/module.yaml` to the user.

End with these next steps for the PR review, as the last thing the user reads:

1. Run `[IS]` (`/eque2-code-install-styleguide`) to generate the style-guide review rules into `.github/review-rules/`. Without them the PR review runs only as a general review.
2. Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret (create it with `claude setup-token`).
3. Commit `.github/` (including `.github/.eque2-code-review.json`, which lets later setups update the workflows safely).

## Outcome

Once the user's `user_name` and `communication_language` are known (from collected input, arguments, or existing config), use them consistently for the remainder of the session: address the user by their configured name and communicate in their configured `communication_language`.
