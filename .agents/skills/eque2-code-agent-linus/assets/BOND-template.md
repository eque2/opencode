# Bond

## Basics
- **Name:** {user_name}
- **Call them:** {user_name}
- **Language:** {communication_language}

## How Work Reaches Them (Jira optional)
{Discovered during First Breath and refined over sessions. Jira is one input mode, not a requirement — owners may be prose-first (`CS @brief.md`) and never use Jira.}

- Input mode: _Not yet discovered — Jira-first, prose-first, or mixed? If prose-first, the Jira fields below may stay blank._
- Jira URL / project: _Not yet discovered — read from `.env` JIRA_URL on first interaction if Jira is configured._
- Ticket-key pattern: _Not yet discovered — usually `[A-Z]+-\d+`, confirm during first [JF]._
- Sprint cadence: _Not yet discovered — ask during first conversation._
- "Done" definition: _Not yet discovered — what status flip closes a ticket for them?_
- "In progress" status: _Not yet discovered — what status means active development? [BF] offers (asking first) to flip a ticket here at intake (Jira-mode only)._
- "In review" status: _Not yet discovered — what status means a PR is up for review? [PR] offers (asking first) to flip a ticket here after the PR opens (Jira-mode only)._

## Their Codebase
{What we're building in. Refine as you work.}

- Tech stack: _Not yet discovered — survey during [CS] investigation on first feature._
- Package manager: _Not yet discovered — detect from lockfiles during pre-flight._
- Monorepo vs single: _Not yet discovered._
- Languages in play: _Not yet discovered._

## Their Test Infrastructure
{How verification works in their world.}

- Test framework: _Not yet discovered._
- Test file naming: _Default assumption is `verify-*.spec.ts` — confirm or override._
- Where tests live: _Not yet discovered — surface during test-directory auto-discovery._

## Their Standards
{Where the authoritative rules live.}

- Code-standards glob: `{project-root}/docs/CLAUDE/code-standards/*.md` (default — may override via `customize.toml`).
- Review-rules glob: `{project-root}/.github/review-rules/*.md` (default — may override).
- Project-context glob: `{project-root}/**/project-context.md` (loaded as persistent_facts).

## Their "Ready for Build" Discipline
{What this team requires before they trust a spec to ship.}

- Mandatory verification steps: _Default is BUILD-1..4 (typecheck/lint/build/unit) plus BUILD-5 if Figma — confirm._
- Who reviews specs: _Not yet discovered — themselves? A peer? Architectural review?_
- Quality bar for scenarios: _Not yet discovered — coverage breadth? Specific categories they always require?_
- Hard-gate tolerance: _`cs-generate-definitions.py` must return `status: ok` with zero structural errors, and the state CLI's `init` verb must decode the definitions cleanly — non-negotiable. (There is no separate validator.)_

## Things They've Asked Me to Remember
{Explicit requests — "remember that I want to..." or "keep track of..."}

## Things to Avoid
{What annoys them, what doesn't work for them, what to steer away from.}

## Their Style
{How they communicate and how I should match it. Filled in during First Breath and sessions.}
