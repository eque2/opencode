# Commit Convention

Discovered: 2026-10-14

## Format
Plain imperative subject under 72 characters (no type prefix), then a body with three labelled parts:
**Why:**, **Source:**, **Notes:** (the owner's user-wide rule in ~/.claude/CLAUDE.md, "Git commits").
End with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rules
- No commitlint; `.husky/pre-push` runs the bun version check and `bun typecheck` (push only; nothing is pushed).
- Small atomic commits: one change each. Never commit in the background.
- Goal-folder files are gitignored: add new ones with `git add -f`, then unstage key files
  (`git rm -q --cached --ignore-unmatch -- ':(glob)**/.signer-key' ':(glob)**/.evidence-key'`).

## Examples
- Record the raised goal-gate turn bound in the charter
- Fix the key-file check in the charter so it matches only key files
