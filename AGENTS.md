<!-- bmad:context -->
<!-- Verified 2026-09-22 against OpenCode fe3f3a41f7 and eque2-code 645cd89e81. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Eque2 OpenCode fork

This repository is Eque2's OpenCode fork. It is a Bun and TypeScript monorepo based on upstream OpenCode. The sibling `../eque2-code/` repository supplies Eque2 workflows and policy. Deeper OpenCode designs live in `specs/`, and the integration plan lives in the sibling Eque2 research folder.

## Policy

- Keep OpenCode runtime changes host-generic. Keep Eque2 policy and workflow decisions in the Eque2 plugin and CLIs.
- Do not implement or ship an external goal watcher. Use native lifecycle and settlement primitives.
- Treat live SSE as progress telemetry only. Use durable settlement as completion proof.
- Use `dev` as the default branch. Use `dev` or `origin/dev` for comparisons.
- Use a branch name of three words or fewer. Separate words with hyphens, and do not use type prefixes.
- Use `type(scope): summary` for commits and pull request titles. The scope is optional; use the affected package when helpful. Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`.
- Get a design review before implementing a UI or core product feature.
- Set `OPENCODE_SERVER_PASSWORD` whenever server mode is enabled.
- Do not submit an AI-generated security report.

## Where things are

- Core runtime and server: `packages/opencode/`
- Shared web application: `packages/app/`
- Desktop application: `packages/desktop/`
- Plugin SDK: `packages/plugin/`
- OpenCode designs: `specs/`
- Eque2 integration plan: `../eque2-code/_bmad-output/planning-artifacts/research/technical-opencode-only-eque2-code-migration-2026-09-22/research.md`
- Fork feature backlog: `../eque2-code/_bmad-output/planning-artifacts/research/technical-opencode-only-eque2-code-migration-2026-09-22/opencode-fork-feature-backlog.md`
- Follow the nearest nested `AGENTS.md` when one exists.

## Running and verifying

- Use Bun 1.3.14. The pre-push hook accepts `^1.3.14` and warns when the exact version differs.
- On Windows, run `bun install --linker hoisted`. The normal linker fails with patched peer variants.
- Do not run bare `bun test` at the repository root. Run package tests instead.
- Run `GITHUB_ACTIONS=false bun turbo test` at the root for the workspace test suite.
- Run `bun typecheck` in the changed package for fast feedback. Run it at the root for the full workspace.
- Do not invoke `tsc` directly. Use the repository or package scripts.
- For HTTP API work, also run `bun run check:generated` in `packages/client` and `bun run test:httpapi` in `packages/opencode`.
- After public Protocol or Server `HttpApi` changes, run `bun run generate` in `packages/client`.
- Never edit `packages/client/src/generated/` or `packages/client/src/generated-effect/` directly.
- Run `./packages/sdk/js/script/build.ts` to regenerate only the legacy JavaScript SDK.
- Run `./script/generate.ts` at the root when all generated API outputs need an update.
- After core schema changes, run `bun run migration` in `packages/core`.
- Never hand-edit generated core schema or migration files.
- Use Node 24.15 for application E2E setup. Playwright 1.59 hangs during Chromium extraction with Node 24.16.

## Conventions that differ from defaults

- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server.
- Let Client runtime code depend on Schema and Protocol, but never on Core or Server.
- Let `sdk-next` compose Client, Core, and Server.
- Use the pinned Effect v4 implementation and project patterns. Read `.opencode/skills/effect/SKILL.md`.
- The project Effect v4 rule overrides the user-wide Effect v3 default.
- Keep simple logic at its call site. Extract only reusable code, complex boundaries, or clearly named concepts.
- Make complex functions show the happy path. Put supporting helpers below the main export when this improves clarity.
- Keep synchronous parsing and option construction synchronous. Return `Effect` only for effectful work.
- Avoid `try` and `catch` where possible.
- Avoid `any`.
- Prefer Bun APIs when they fit the task.
- Prefer type inference. Add explicit types for exports or clarity.
- Prefer `flatMap`, `filter`, and `map` over loops. Use type guards to preserve inference.
- In `packages/opencode/src/config`, use the existing self-export pattern for new modules.
- In Effect generators, bind a service to a named variable before calling its methods.
- Inline a value that has one use. Prefer `const`, ternaries, and early returns over reassignment.
- Avoid unnecessary destructuring. Use dot notation when it preserves context.
- Do not alias imports or use star imports.
- Import a module's exported namespace by name when namespace-style access is necessary.
- Use narrow dynamic imports for heavy conditional modules. Destructure bindings near the top of the narrowest applicable scope.
- Keep each dynamic import inside the applicable branch. Do not use inline import chains.
- Avoid `else`. Return early.
- Use Effect Schema helpers for untrusted JSON.
- Comment non-obvious constraints and surprising behavior. Do not comment obvious operations.
- Use snake case for Drizzle fields so column names do not need string mappings.
- Test the real implementation. Do not duplicate production algorithms inside tests.
- Avoid broad mocks and `globalThis` mocks. Use focused `Layer.mock` overrides for Effect service boundaries when necessary.

### V2 session core

- Keep durable prompt admission separate from model execution.
- Admit one durable `session_input` before scheduling an advisory wake, unless `resume: false` requests admission only.
- Reuse a Session ID to adopt that Session. Reuse a prompt message ID only when the Session, prompt, and delivery mode match exactly.
- Reject conflicting prompt message reuse. Lazily synthesize promoted inbox records for exact retries of historical projected prompts.
- Keep `SessionExecution` process-global and Session-ID based. Resolve placement through `SessionStore` and `LocationServiceMap` when a drain starts.
- Do not make a layer take a Session ID. Treat interruption of idle or missing ownership as a no-op.
- Keep the runner, model resolution, tool registry, permissions, and filesystem Location-scoped.
- Treat an omitted `Location.workspaceID` as implicit-local placement. Reserve explicit workspace identity for future placement semantics.
- Preserve one explicit `llm.stream(request)` call for each provider turn.
- Reload projected history before durable continuation. Do not bridge through `SessionPrompt.loop(...)` or an in-memory tool loop.
- Keep local drains process-local until clustering exists.
- Let `SessionRunCoordinator` join same-Session resumes, coalesce wakes, and run different Sessions concurrently.
- Treat advisory wakes as requests to drain eligible durable inbox rows. Do not treat a drain as a durable identity or transcript boundary.
- Do not retry provider work after a crash until a separate recovery design exists.
- Promote steers at the next safe provider-turn boundary while the active drain needs continuation.
- Keep queued input pending until the Session would otherwise become idle. Promote one queued input, then reevaluate continuation.
- Reset the selected agent's provider-turn allowance when promoted user input arrives. Reset it once for a steer batch.
- Keep EventV2 replay ownership separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`.
- Keep Context Source producers with their observed domains.
- Keep Session History selection and Context Epoch persistence Session-owned.

## Known pitfalls

- The parent workspace is not a Git repository. `../eque2-code/` is a separate repository.
- A local `main` reference might not exist.
- Bare root `bun test` fails deliberately. The root workspace suite uses Turbo.
- Stock OpenCode does not provide the required Eque2 goal-loop parity.
- Do not embed signed state, verifier rules, or worker policy in the OpenCode runtime.

<!-- /bmad:context -->

<!-- >>> eque2-code managed (do not edit this block) >>> -->
## eque2-code (installed module)

eque2-code skills are installed under `.agents/skills/`. Each skill is a folder with a `SKILL.md` — read it and follow it when the user invokes that capability. Entry points:

- `.agents/skills/eque2-code-agent-linus/SKILL.md` — **Linus**, feature-development orchestrator: Jira ticket or prose brief → spec → build → E2E test → PR. Invoke for 'talk to Linus', 'implement a ticket', 'spec a brief', 'fix a bug', 'open a PR', or a dispatch code like `JF <TICKET>` / `CS @brief.md`.
- `.agents/skills/eque2-code-agent-grace/SKILL.md` — **Grace**, test-automation orchestrator over the Xray-backed test lifecycle (build, backfill, validate, report).
- `.agents/skills/eque2-code-setup/SKILL.md` — module setup / re-setup.

State, tests, and Xray operations are plain bundled Node CLIs (no MCP server, no Docker):

- `node .agents/skills/eque2-code-setup/scripts/state.mjs <verb> …` — signed spec/scenario state
- `node .agents/skills/eque2-code-setup/scripts/tests-cli.mjs <verb> …` — test-backfill lifecycle
- `node .agents/skills/eque2-code-setup/scripts/xray-cli.mjs <verb> …` — Xray fetch/sync

Where a skill file uses the literal token `{skills-root}`, resolve it to `.agents/skills` in this repo. Where it uses `{project-root}`, resolve it to the repo root.

### eque2-code anti-tamper policy

Evidence, state files, and signing keys are protected by POLICY, not by a structural fence — read this carefully: the shared integrity key is a committed plaintext keyring (`state/integrity-key.json`), in the repo by deliberate design, and reading it is STILL forbidden. Do NOT: (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state folders directly — all state changes go through the state/tests CLI; (3) forge or hand-edit a verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a legacy keychain entry); (5) modify the enforcement programs themselves — the state/tests CLIs, reporters, hooks, and goal-gate scripts under any `skills/eque2-code-*/scripts/` tree (`state.mjs`, `tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`), because the policy protects the data only while the program that checks it is intact — a loosened validator makes every later verdict worthless. A schema or verb change there needs the owner's explicit instruction or an upstream release, and lands as its own commit stating the contract diff. Tampering is EVIDENT on pull (HMAC verify-at-read) unless the tamperer ALSO re-signs with the committed key — which requires the forbidden key read above, turning a silent edit into a deliberate, named policy violation — and a verdict from an unregistered key is cryptographically rejected (Ed25519 verify-at-read); a same-machine agent is deterred by this policy, not prevented by an unbypassable structure. Agents caught forging evidence or state may be switched off and replaced with an agent with more integrity.

Only the verifier role mints test verdicts (incident CMC-32874). Hookless runtimes dispatch verification through `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- <verifier command>`, which mints/revokes the role marker the tests CLI checks.

**Clause A — never-probe:** Privileged verbs (`verdict`, `force-reset`, `verification-reset`) are never invoked to see what happens, to discover flags, or to test validation. Discovery is `--help` only. Sole exception: inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode (the sanctioned test path this project's own suite uses).

**Clause B — anti-reclassification:** Running a mint verb IS minting, whatever you call it — probe, test, dry run, experiment. There is no intent exception outside the sanctioned canary mode above; the CLI records the invocation as an attempt regardless of outcome.
<!-- <<< eque2-code managed (do not edit this block) <<< -->
