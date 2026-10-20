#!/bin/zsh
# runcheck.sh <BUILD-id> <log> <command...>: run one build check from the repo root and complete it with its exit code.
id=$1; log=$2; shift 2
cd /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
S=$PWD/_bmad-output/goals/task-harness-feedback.goal/spec; CLI=".claude/skills/eque2-code-setup/scripts/state.mjs"
node $CLI "$S" update $id start --reason "Running $id on the goal branch at $(git rev-parse --short HEAD)" > $log.state 2>&1
start=$(python3 -c 'import time;print(int(time.time()*1000))')
{ date; git rev-parse --short HEAD; uptime; } > $log
zsh -c "$*" >> $log 2>&1; code=$?
end=$(python3 -c 'import time;print(int(time.time()*1000))')
{ echo "EXIT=$code"; date; uptime; } >> $log
node $CLI "$S" update $id complete --exit-code=$code --duration-ms=$((end-start)) --commit-sha=$(git rev-parse HEAD) --reason "$* at $(git rev-parse --short HEAD): exit $code" >> $log.state 2>&1
echo "$id DONE exit=$code"
