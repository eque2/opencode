#!/bin/bash
# Dry-run proofs of the adapter's mapping and refusal rules. The reporter is never imported (--dry-run).
A=/private/tmp/claude-501/-Users-marknorgate-Projects-eque2-repos-eque2-opencode-workspace-opencode--claude-worktrees-task-harness-feedback/3878ca44-82a4-48b1-8281-9fa90483a400/scratchpad/adapter
F=$A/fixtures; S=$A/shims; P=$A/proofs; AD=$A/bun-junit-scenario-adapter.mjs
pass=0; failn=0
check() { # id expectedExit expectedDecisionPrefix -- adapter args...
  local id=$1 want=$2 decision=$3; shift 3
  node $AD --cwd=$F --runs=$P/runs --dry-run "$@" > $P/$id.out 2> $P/$id.err; local got=$?
  local line; line=$(grep -o 'decision=[^ ]*' $P/$id.err | tail -1)
  local reason; reason=$(grep 'REFUSED\|mapped:' $P/$id.err | tail -1)
  if [ "$got" = "$want" ] && [[ "$line" == "decision=$decision"* ]]; then
    echo "PROOF $id: OK   exit=$got $line | $reason"; pass=$((pass+1))
  else
    echo "PROOF $id: FAIL exit=$got (want $want) $line (want $decision) | $reason"; failn=$((failn+1))
  fi
}
check P2-all-pass        0 dry-run:mapped --file=./pass.test.ts
check P3-module-throw    1 dry-run:mapped --file=./throw-module.test.ts
check P4-afterall-throw  1 dry-run:mapped --file=./afterall.test.ts
cp $F/selfedit.template.ts $F/selfedit.test.ts
check P5-R4-self-edit    3 refused:R4     --file=./selfedit.test.ts
check P6-R3-green-noreport 3 refused:R3   --file=./pass.test.ts --bun=$S/green-no-report.sh
check P7-R1-other-file   3 refused:R1     --file=./pass.test.ts --bun=$S/other-file.sh
check P8-R1-two-files    3 refused:R1     --file=./pass.test.ts --bun=$S/two-files.sh
check P9-R2-drop-case    3 refused:R2     --file=./pass.test.ts --bun=$S/drop-case.sh
check P10-R2-vs-summary  3 refused:R2     --file=./pass.test.ts --bun=$S/consistent-drop.sh
check P11-R5-idle-kill   3 refused:R5     --file=./hang.test.ts --idle-ms=3000
echo "PROOFS: $pass ok, $failn failed"
