# Xray fetch — the verbs [ET] depends on

`[ET]` fetches Xray definitions + step counts through the **xray CLI** (`xray-cli.ts`), which is **owned by eque2-code** (source: `src/eque2-code/scripts/xray-cli.ts` + `services/xray-client.ts`). There is **zero dependency on the eque2-test module** — the client was brought into eque2-code as a true supersession, and `[ET]` invokes no eque2-test workflow/skill. There is no MCP transport and nothing to register — the CLI is invoked directly as a host process.

## Verbs (CLI commands)

Invocation shape: `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <command> [--flag=value ...]`. Success prints one JSON object to stdout and exits 0; failure prints `{"error": "..."}` to stderr and exits 1.

### `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync` — fetch/refresh definitions to disk
Fetches the current Xray definitions for a folder and writes them to `test-plans/{folderPath}/{KEY}.json`. This is **the fetch** the gate runs — the local JSON is an *output* of this call, never an assumed input.

- **Flags:** `--folderId=<id>`, `--conflictPolicy=merge|skip|overwrite`
- **Returns:** `{ synced, created, updated, skipped }`
- Auth via `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET`; endpoint `${XRAY_BASE_URL}/api/v2/graphql`. Resumable; honours `XRAY_PAGE_DELAY_MS`.

### `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs test` — read a definition + stepCount
Reads a single test definition (latest history entry) from the synced local copy and returns its steps and **`stepCount`** — the gate's source of truth.

- **Flags:** `--testId=<id>` (required — the Jira/Xray key), `--historyIndex=<n>`
- **Returns:** `{ id, name, url, steps: [{ action, data?, result? }], stepCount, preconditions: [...], attachments?, historyId, historyDate }`
- `stepCount = steps.length` for the selected history entry.

### `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs tests` / `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` — locate / list
`tests --testIds=<KEY>` reports a key's `folderPath` (used by the gate's folder-mismatch guard). `folders` lists the folder hierarchy (used at First Breath to pick `XRAY_TEST_FOLDER`).

### Other verbs
`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs status` and `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs diff [--folderId=<id>]` and `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs steps --testId=<id> [--historyIndex=<n>]` are also available (see `--help`), though `[ET]` itself only calls `sync`, `test`, `tests`, and `folders`.

## How the skill uses them

| Stage | Verb | Use |
|---|---|---|
| `01-first-breath.md` | `folders` | pick the project's `XRAY_TEST_FOLDER` |
| `02-xray-gate.md` | `sync` → `test` (+ `tests` guard) | refresh the folder, read `stepCount`, gate on `> 0`; the guard catches a key that lives in a different folder so a folder mismatch never causes a false HARD STOP |
| `03-prepare.md` | (reads the synced JSON) | load `steps[]`, `preconditions[]`, `url` from `test-plans/{folderPath}/{ticket_key}.json` |

The gate always **syncs before reading**, so "fetched fresh, never cached" actually holds — `test` reads the copy `sync` just wrote.

## Resolving credentials

The CLI reads `.env` itself (walking up from `process.cwd()`), the same way the rest of eque2-code's scripts do — no separate registration step. `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET` (and `XRAY_BASE_URL` if non-default) must be present in `.env` for `sync`/`test`/`tests`/`folders` to succeed.

## Recording the outcome

`[ET]` records outcomes in a **handoff artifact** `{feature_artifacts}/e2e-test-{slug}/e2e-test.md` (see `07-complete.md`), modelled on `[BF]`'s `bug-fix.md`. It does **not** write to the eque2-code state machine — an E2E test is not a tracked actor (no state-CLI verb/ID corresponds to it). The committed spec file + the handoff are the durable evidence. The eque2-code **state CLI is unchanged** by this skill; only the xray CLI is used — so the trust graph and actor machines are untouched (Decision 6's `analyze-state-machine` concern does not apply to state verbs, and is confirmed below in the build log).
