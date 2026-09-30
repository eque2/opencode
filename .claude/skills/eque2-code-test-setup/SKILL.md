---
name: eque2-code-test-setup
description: Discovers and persists the test topology (what is under test, where tests live, where Xray definitions land) and establishes test standards. Invoked by Grace when the user selects [SU] or asks to set up / reconfigure the test environment.
---

# Test Setup

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Conversational discovery and persistence of the **test topology** — the run-once (but re-runnable) bootstrap every other Grace capability reads from. It answers three questions and writes the answers down: *what* is under test, *where* the Playwright tests live, and *where* Xray definitions land. It also establishes the project's test standards, reusing the shared `[ET]` Stage 1 idiom.

This is discovery, **not** assumption. The old installer assumed co-located tests in the current repo; that assumption is wrong. Four configurations are all valid — with the current repo called "chonk", Grace may be:

1. testing the chonk code, with E2E tests living in the chonk repo;
2. testing the chonk code, with E2E tests living in a separate repo;
3. testing an entirely different codebase, with E2E tests in that codebase's repo;
4. testing an entirely different codebase, with E2E tests in a separate test repo.

So there are **three independent locations**: the code under test (which may not be present locally at all — only reachable as a deployed `BASE_URL`), the test-code directory (`TEST_CODE_DIR`, possibly an absolute path into another checkout), and the working repo where Grace runs.

## Outcomes

A successful run leaves all of the following true:

1. **Existing setup inspected, not assumed.** The current repo has been checked for an existing Playwright setup (`@playwright/test` in `package.json`, a `playwright.config.*`, existing spec/POM directories) and any prior `[SU]`/`[ET]` config in `.env` — found values are confirmed with the user and reused, never re-asked from scratch.
2. **What is under test is established:** the deployed `BASE_URL`, and (where it exists locally) the code-under-test repo, branch and environment. If the code under test is only reachable as a deployed URL, that is recorded as such.
3. **Where tests live is established:** `TEST_CODE_DIR` — possibly an absolute path into another checkout. When it points outside the working repo, **verify it is a git checkout the agent may commit to** (it exists, `git status` works there, and the user confirms commit rights) before accepting it.
4. **Config persisted to `.env`:** `BASE_URL`, `TEST_CODE_DIR`, `XRAY_OUTPUT_DIR` (default `./test-plans`), and Xray credentials (`XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET`). Re-running **updates** existing keys in place — never duplicates them. Rationale (why each choice) goes to the sanctum, not `.env`.
5. **Git semantics recorded:** when tests live in a separate repo, commits and pushes from test builds target *that* repo, not the working repo. This is written down where `[BT]`/`[BK]` subagents will read it.
6. **Test standards established or confirmed** per the shared `[ET]` Stage 1 idiom: if `docs/CLAUDE/test-standards/test-standards.md` exists, reuse it; otherwise generate it — TEA knowledge first (`_bmad/tea/testarch/knowledge/*`), falling back to `eque2-code-e2e-test/references/test-standards-defaults.md` — adapted to the detected stack, with severity-tagged rules.

## Inputs

- No required argument. Optional: `--reconfigure` to clear stored answers and re-run the full Q&A.
- Anything already in `.env` / the working tree is an input — found state seeds the conversation.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-test-setup`) or dispatched by Grace. Unless the activation context already carries resolved config and a passing pre-flight (Grace just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. Run shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}`. `[SU]` is itself the remedy for most environment gaps, so treat pre-flight findings as conversation seeds, not blockers.

Xray credentials are validated by listing folders via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` — **never** via bespoke scripts or direct API calls. If the credentials are absent or invalid, record the gap and tell the user `[FT]` will need them; do not fail the whole setup over it.

## Failure modes

- **`TEST_CODE_DIR` points at a path that is not a writable git checkout** → do not persist it; explain what was found and ask again.
- **Conflicting prior config** (e.g. `.env` says one thing, the repo plainly shows another) → surface the conflict and let the user decide; never silently overwrite.
- **User cannot answer a topology question** → persist what is known, mark the rest unanswered, and say plainly which downstream capabilities are blocked until it is filled in.

## Success criteria

`.env` carries `BASE_URL`, `TEST_CODE_DIR`, `XRAY_OUTPUT_DIR` and Xray credentials (or recorded, deliberate gaps); test standards exist; topology rationale and git semantics are in the sanctum; and a second run of `[SU]` immediately after would find everything present and have nothing to ask.

## Dispatch

- **Dispatched by Grace:** config + pre-flight ran this turn — begin discovery directly.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then begin discovery.

Not headless — topology discovery is a conversation. Headless callers get documented defaults via the individual workflows' own first-breath gates instead.
