#!/bin/zsh
# runpass.sh <BUILD-id> <log> <command...>: run a check whose actor is already building; complete it only on exit 0.
# A failed run (for example a load timeout) is logged and leaves the actor building for another attempt.
id=$1; log=$2; shift 2
cd /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
S=$PWD/_bmad-output/goals/task-harness-feedback.goal/spec; CLI=".claude/skills/eque2-code-setup/scripts/state.mjs"
start=$(python3 -c 'import time;print(int(time.time()*1000))')
{ date; git rev-parse --short HEAD; uptime; } > $log
zsh -c "$*" >> $log 2>&1; code=$?
end=$(python3 -c 'import time;print(int(time.time()*1000))')
{ echo "EXIT=$code"; date; uptime; } >> $log
if [ $code -eq 0 ]; then
  node $CLI "$S" update $id complete --exit-code=0 --duration-ms=$((end-start)) --commit-sha=$(git rev-parse HEAD) --reason "$* at $(git rev-parse --short HEAD): exit 0" > $log.state 2>&1
fi
echo "$id DONE exit=$code"
