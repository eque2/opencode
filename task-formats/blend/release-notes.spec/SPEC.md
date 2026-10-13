---
format: task-spec/1
policy:
  redFirst: true
  proofBinding: title-tag
  structural: touches-plus-tests
  review: parent-diff
  trust: independent-verifier
  acceptance: after-all-needs-trusted
  evidence: [exit-code, counts, run-id, commit]
  budgets: {taskAttempts: 3, retries: 2}
  judges:
    test: [runner, verifier]
    gate: [runner]
    unchanged: [engine]
    review: [reviewer]
gates:
  BUILD-1:
    title: "Type check passes"
    command: "bun run typecheck"
    requires: "Bun 1.3; dev dependencies installed with `bun install --frozen-lockfile`"
  BUILD-2:
    title: "Lint passes"
    command: "bun run lint"
    requires: "Bun 1.3; dev dependencies installed with `bun install --frozen-lockfile`"
  BUILD-3:
    title: "Build succeeds"
    command: "bun run build"
    requires: "Bun 1.3; `src/cli.ts` exists"
  BUILD-4:
    title: "Tests pass"
    command: "bun test"
    requires: "Bun 1.3; git 2.24 or later on the PATH"
refs:
  CC-1: "Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/), rules 1, 4, 6, 8, 9, 12, 13, 15 and 16: header `type(scope)!: description`; `!` immediately before the colon; footers are a word token plus `: ` or ` #`; `BREAKING CHANGE` is upper case and `BREAKING-CHANGE` is its synonym; types are case-insensitive."
  SV-1: "Semantic Versioning 2.0.0 (https://semver.org/spec/v2.0.0.html), rules 2, 4, 7, 8, 9 and 10. This package adds two rules: below 1.0.0 a breaking change gives minor, and `perf` gives patch."
  RN-D1: "Plain TypeScript with no runtime dependency and no Effect; `strict`, no `any`; sibling modules imported without an extension (`./commit`)."
  RN-D2: "`commit.ts`, `bump.ts`, `render.ts` and `links.ts` are pure: no I/O, no clock, no randomness. Only `cli.ts` touches the process."
  RN-D3: "Exit codes: 0 success and `--help`; 2 bad arguments; 3 not a git repository; 4 git not found."
  RN-D4: "Tests are deterministic and offline: no network, no clock, no randomness; git is isolated with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, fixed author and committer identities and dates, and `GIT_CEILING_DIRECTORIES`."
  RN-A2: "The default issue-key pattern is `^[A-Z][A-Z0-9]+-\\d+$`, used when the config gives no `keyPattern`."
outside:
  T8: "Publish the package to the registry from the release pipeline"
  T9: "Agree the issue-key pattern and URL template with the issue-tracker owners"
---

# Release notes from conventional commits

This spec is the task fixture of the spike `spike-task-harness`. It was converted from the
`eque2-code-create-spec` output in `_bmad-output/features/release-notes/` (status `ready-for-build`).

Every path resolves from the package root: a fresh temporary git repository seeded from
`packages/opencode/test/task-harness/release-notes-repo/`. The seed holds `package.json` (name
`@eque2-spike/release-notes`, version `0.1.0`, `files: ["src/"]`, the scripts `typecheck`, `lint`, `build` and
`test`, and the dev dependencies `typescript` 5.9.3, `oxlint` 1.60.0 and `@types/bun` 1.3.13), a committed
`bun.lock`, `tsconfig.json`, `.gitignore`, an empty `src/` and an empty `test/`.

`outside` names two preconditions. T8 publishes the package; only the deployed scenario S13 needs it. T9 records
the issue-key agreement; only T1.5 waits on it.

Scenario ids map from the source spec as follows: S1–S6 keep their ids; N1 → S7, N2 → S8, N3 → S9, N4 → S10,
N5 → S11, DI1 → S12, DELIVERY-1 → S13. The build checks BUILD-1 to BUILD-4 are the gates above.
