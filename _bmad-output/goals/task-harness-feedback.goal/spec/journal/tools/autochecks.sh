#!/bin/zsh
# Run BUILD-4 until it passes, then BUILD-6 until it passes; each attempt waits for a 1-minute load below 15.
# An attempt that fails is logged; only an exit-0 run is recorded with `complete`.
W=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/tools
cd /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
S=$PWD/_bmad-output/goals/task-harness-feedback.goal/spec; CLI=".claude/skills/eque2-code-setup/scripts/state.mjs"
quiet() { while [ $(sysctl -n vm.loadavg | awk '{print int($2)}') -ge 15 ]; do sleep 30; done; }
attempt() { # id log command
  local id=$1 log=$2; shift 2
  quiet
  local start=$(python3 -c 'import time;print(int(time.time()*1000))')
  { date; git rev-parse --short HEAD; uptime; } > $log
  zsh -c "$*" >> $log 2>&1; local code=$?
  local end=$(python3 -c 'import time;print(int(time.time()*1000))')
  { echo "EXIT=$code"; date; uptime; } >> $log
  if [ $code -eq 0 ]; then
    node $CLI "$S" update $id complete --exit-code=0 --duration-ms=$((end-start)) --commit-sha=$(git rev-parse HEAD) --reason "$* at $(git rev-parse --short HEAD): exit 0" > $log.state 2>&1
  fi
  echo "$(date '+%H:%M') $id $(basename $log) exit=$code" >> $W/autochecks.out
  return $code
}
for n in 9 10 11 12 13 14; do
  attempt BUILD-4 $W/build4-a$n.log "bun run --cwd packages/opencode test && bun run --cwd packages/tui test" && break
  sleep 60
done
grep -q 'BUILD-4 .* exit=0' $W/autochecks.out || { echo "$(date '+%H:%M') BUILD-4 gave up" >> $W/autochecks.out; exit 1; }
node $CLI "$S" update BUILD-6 start --reason "Running BUILD-6 on the goal branch at $(git rev-parse --short HEAD)" > $W/build6.start 2>&1
for n in 1 2 3 4; do
  attempt BUILD-6 $W/build6-a$n.log "cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1" && break
  sleep 60
done
echo "$(date '+%H:%M') done" >> $W/autochecks.out
