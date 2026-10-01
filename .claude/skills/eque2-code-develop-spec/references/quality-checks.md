# Quality Checks & Commit Standards

## When to run

- **Once**, as the final gate before the spec is marked done (in the `done` branch of the orchestrator loop, `references/execute.md`).

This is the only orchestrator-level quality gate. It runs a single full-suite pass over the whole worktree after all tasks and verifications complete — not per parent task and not per parallel batch. (Each build subagent still lint/type-checks its own diff as it works; that self-check is unchanged and is a separate, unit-local concern — see `references/subagent-prompt.md`.)

Treat **warnings as errors**. All checks must pass cleanly.

## Lint & type-check discovery

On first run, discover the repo's commands. Check in order:

1. `{project-root}/docs/CLAUDE/CLAUDE.md` — may document exact commands
2. `package.json` scripts — look for `lint`, `typecheck`, `type-check`, `check`, `tsc`
3. Config files — `.eslintrc*`, `biome.json`, `tsconfig.json`, `.prettierrc*`
4. Common fallbacks: `npm run lint`, `npm run typecheck`, `npx tsc --noEmit`, `npx eslint .`, `npx biome check .`

### Cache discovered commands

Write to `journal/quality-checks.md` so subsequent iterations don't repeat discovery:

```markdown
# Quality Check Commands

Discovered: {timestamp}

## Lint
{command}

## Type Check
{command}
```

On subsequent runs, read `journal/quality-checks.md` first and use the cached commands.

Run all discovered commands from the worktree root. If any exit non-zero: read the error, fix the issues (you own them), re-run. Do NOT skip lint/typecheck failures. Do NOT use `--no-verify` or equivalent suppressions.

## Commit convention discovery

On first commit, discover the repo's conventions. Check in order:

1. `commitlint.config.*` or `.commitlintrc.*` — rules
2. `.husky/commit-msg` — enforcement hooks
3. `.czrc` or `cz-config.js` — commitizen config
4. `git log --oneline -10` — existing patterns
5. `CLAUDE.md` or `CONTRIBUTING.md` — documented conventions

### Cache discovered convention

Write to `journal/commit-convention.md`:

```markdown
# Commit Convention

Discovered: {timestamp}

## Format
{format pattern, e.g., "type(scope): description"}

## Rules
- Types: {allowed types}
- Scopes: {allowed scopes, or "any"}
- Case: {convention}

## Examples
{2-3 recent commits}
```

On subsequent commits, read `journal/commit-convention.md` first and follow the cached convention.

**Never hardcode commit message format.** **Never run `git commit` in background** — you must see hook output to recover from failures. If a commit hook fails, read the error, fix the message, and retry. Do NOT use `--no-verify`.
