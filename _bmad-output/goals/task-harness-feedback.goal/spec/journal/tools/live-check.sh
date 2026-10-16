#!/bin/zsh
# The AC 27 live check, in tmux (goal.md "The live check"): each run in a new empty folder and its own tmux session.
#   live-check.sh new <name>            seed a new folder with task-demo.sh and open the TUI in tmux session <name>
#   live-check.sh send <name> <text>    type <text> and Enter into the TUI
#   live-check.sh capture <name> <file> save the pane with its colours and attributes (tmux capture-pane -e)
#   live-check.sh spend <name>          the summed stored cost and tokens of the sessions in the folder (the cap's measure)
#   live-check.sh stop <name>           close the tmux session
set -eu
ROOT=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
BASE=$ROOT/.task-conformance/live
DB=$HOME/.local/share/opencode/opencode-local.db
cmd=$1; name=$2; dir=$BASE/$name
case $cmd in
  new)
    [ -e $dir ] && { echo "live-check: $dir exists; use a new name"; exit 1; }
    mkdir -p $dir
    tmux new-session -d -s $name -x 220 -y 56 -c $dir "bash $ROOT/packages/opencode/script/task-demo.sh"
    echo "$dir" ;;
  send) tmux send-keys -t $name -l -- "$3"; tmux send-keys -t $name Enter ;;
  capture) tmux capture-pane -e -p -t $name > $3; echo "$3" ;;
  spend) sqlite3 -readonly $DB "select count(*), round(sum(cost),4), sum(tokens_input+tokens_output+tokens_reasoning) from session where directory = '$dir';" ;;
  stop) tmux kill-session -t $name ;;
  *) echo "live-check: unknown command $cmd"; exit 2 ;;
esac
