#!/bin/zsh
# commit-batch.sh <tests|records> <ID...>: commit a finished verify batch's test files, or its journals and transcripts.
mode=$1; shift
cd /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
S=_bmad-output/goals/task-harness-feedback.goal/spec
ids=("$@"); label="${ids[1]}-${ids[-1]}"; [ ${#ids} -eq 1 ] && label=${ids[1]}
if [ $mode = tests ]; then
  files=(); for id in $ids; do files+=(packages/opencode/test/task/verify-spec-$id.spec.ts); done
  for f in $files; do [ -f $f ] || { echo "missing $f"; exit 1; }; done
  npx prettier --check $files 2>&1 | tail -1
  npx oxlint --deny-warnings $files | grep Found
  git add $files && git commit -q -F - <<MSG
Add the $label scenario tests

Why: scenarios ${ids[*]} had no test of their own; each now has a bun test
whose titles carry its id and drive the real code under test.

Source: develop-spec verify-scenario for ${ids[*]} (spec scenarios.gherkin);
goal.md "Commit every verify-spec-*.spec.ts file the verify step writes".

Notes: each passed through the bun JUnit adapter and Layer 1; the trust
verdicts come from a separate verifier.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
else
  files=(); for id in $ids; do files+=($S/journal/scenario/$id.md); files+=($S/journal/transcripts/$id-verify*-2026*.md(N)); done
  files+=($S/.state-events.jsonl $S/.state-health.json $S/state.md $S/state/HEAD.json $S/state/events.jsonl $S/state/snapshots)
  git add -f -- $files && git rm -q --cached --ignore-unmatch -- ':(glob)**/.signer-key' ':(glob)**/.evidence-key'
  git ls-files | grep -E '(^|/)\.(signer|evidence)-key$' && { echo "KEY STAGED"; exit 1; }
  git commit -q -F - <<MSG
Record the $label scenario journals and state

Why: the $label scenario batch reported; this records its journals,
transcripts and the shared state.

Source: develop-spec verify-scenario / verify-scenario-trust for ${ids[*]}.

Notes: other batches may be in flight; their state lands with their record.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
fi
git log --oneline -1 | cat
