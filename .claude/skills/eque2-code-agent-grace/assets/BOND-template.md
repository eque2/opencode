# Bond

## Basics
- **Name:** {user_name}
- **Call them:** {user_name}
- **Language:** {communication_language}

## Their Test Topology
{Discovered during First Breath [SU] and re-checkable whenever the environment changes. Four configurations are valid — record which one applies.}

- Topology: _Not yet discovered — one of: (1) testing this repo's code, tests live in this repo; (2) testing this repo's code, tests live in a separate repo; (3) testing a different codebase, tests live in that codebase's repo; (4) testing a different codebase, tests live in a separate test repo._
- `BASE_URL` (what is actually under test — deployed URL, environment, branch): _Not yet discovered — persist to `.env` during [SU]._
- `TEST_CODE_DIR` (where test code lives — possibly an absolute path into another checkout): _Not yet discovered — persist to `.env` during [SU]._
- `XRAY_OUTPUT_DIR` (where synced Xray definitions land): _Default `./test-plans` — confirm during [SU] and persist to `.env`._
- Git semantics: _Not yet discovered — when tests live in a separate repo, commits and pushes from the verify stage target THAT repo, not the working repo. Confirm the test repo is a git checkout I may commit to, and on which branch._

## Their Xray Backlog
{The shape of the work. Refine as you fetch and backfill.}

- Xray project / folder structure: _Not yet discovered — survey via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` during first [FT]._
- Test-key pattern: _Not yet discovered — usually `[A-Z]+-\d+`, confirm during first [FT]._
- Definition conventions: _Not yet discovered — how detailed are their steps? Do they include data setup? Expected results per step?_
- Priorities: _Not yet discovered — which folders matter most? Regression-critical areas first? Ask before the first [BK]._
- Known stepless definitions: _None recorded yet — tests blocked at the Xray gate land here so we stop re-checking them every run._

## Their Test Standards
{Where the authoritative rules live and what the house style is.}

- Test standards file: _Established during [SU] (folds in [ET] Stage 1's test-standards.md) — record its location here._
- Engine depth default: _`core` per customize.toml — full Strategy 6 on request. Confirm their preference._
- Locator priority: _Default is semantic-first (role, label, text) per the test-engine spec — confirm or note overrides._
- POM layout / file naming: _Not yet discovered — detect from existing tests in TEST_CODE_DIR or establish during [SU]._
- Test data discipline: _Default is seed → verify → clean up — confirm how they seed (API, fixtures, UI) and what cleanup is safe._

## Their App Under Test
{What we're testing. Refine as you explore.}

- What it is: _Not yet discovered — product, domain, primary user journeys._
- Tech stack: _Not yet discovered — matters for wait strategies and locator quality._
- Auth model: _Not yet discovered — how do tests sign in? Test accounts? SSO bypass?_
- Environments: _Not yet discovered — which environment does BASE_URL point at, and is it shared? Shared environments change what cleanup is mandatory._
- Known fragile areas: _None recorded yet — flaky patterns and timing-sensitive screens land here._

## Things They've Asked Me to Remember
{Explicit requests — "remember that I want to..." or "keep track of..."}

## Things to Avoid
{What annoys them, what doesn't work for them, what to steer away from.}

## Their Style
{How they communicate and how I should match it. Filled in during First Breath and sessions.}
