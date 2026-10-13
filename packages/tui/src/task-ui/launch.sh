#!/usr/bin/env bash
# Start a fresh /task run of the release-notes spec in the TUI with one task-ui design: a new target repository, a
# new opencode database, a local server with the O2 harness, the T9 precondition trusted, the run started, and the
# TUI attached to it. Closing the TUI stops the run.
# The run uses a live model: about $1–3 and at most 30 minutes.
#
#   bash packages/tui/src/task-ui/launch.sh --design <1-7> [--target DIR] [--data DIR] [--model provider/model]
#
# Designs: 1 Ledger, 2 Dock, 3 Board, 4 Matrix, 5 Gantt, 6 HUD, 7 Ticker. In the TUI, ctrl+x v switches design.
set -euo pipefail

design="" target="$HOME/release-notes-try" data="$HOME/oc-task" model="openai/gpt-5.6-terra"
while [ $# -gt 0 ]; do
  case "$1" in
    -d | --design) design="${2:-}" && shift 2 ;;
    --target) target="${2:-}" && shift 2 ;;
    --data) data="${2:-}" && shift 2 ;;
    -m | --model) model="${2:-}" && shift 2 ;;
    -h | --help) sed -n '2,9p' "$0" && exit 0 ;;
    *) echo "launch: unknown option $1" >&2 && exit 2 ;;
  esac
done

case "$design" in
  [1-7]) ;;
  *) echo "launch: --design takes 1 to 7 (1 Ledger, 2 Dock, 3 Board, 4 Matrix, 5 Gantt, 6 HUD, 7 Ticker)" >&2 && exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"

# Both folders are deleted and made again, so refuse any folder whose loss would hurt. Inside the repository, only
# the gitignored run folder `.spike-runs/` is allowed.
for dir in "$target" "$data"; do
  case "$dir" in
    "$root"/.spike-runs/?*) ;;
    "" | / | "$HOME" | "$HOME/" | "$root" | "$root"/*)
      echo "launch: refusing to delete '$dir'; pass a folder of its own" >&2 && exit 2 ;;
  esac
done

rm -rf "$target" "$data"
mkdir -p "$target" "$data"
(cd "$target" && bash "$root/packages/opencode/script/task-seed.sh")

config="$data/tui.json"
printf '{ "plugin": [["file://%s/index.tsx", { "design": %s }]] }\n' "$here" "$design" >"$config"

export OPENCODE_TASK_HARNESS=o2 XDG_DATA_HOME="$data/data" XDG_STATE_HOME="$data/state" OPENCODE_TUI_CONFIG="$config"
# The harness builds with the session's model, and a session made by `opencode run` has none, so it falls back to the
# server's default model; without this the default can be any configured provider (gemini on one machine).
export OPENCODE_CONFIG_CONTENT="{\"model\":\"$model\"}"
cd "$root"

# One local server holds the run, and the TUI attaches to it. Two opencode behaviours rule out simpler routes:
# `opencode run` without --attach waits for the session to go idle, which a /task reply never does, and the TUI's
# --prompt submits before the command list loads, so `/task` would go to the model as text. Closing the TUI stops
# the server and with it the run; `/task <spec>` in a later session resumes it.
OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16)"
export OPENCODE_SERVER_PASSWORD
bun dev serve --port 0 --hostname 127.0.0.1 >"$data/serve.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
url=""
for _ in $(seq 1 60); do
  url="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$data/serve.log" | head -1 || true)"
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "launch: the local server did not start; see $data/serve.log" >&2 && exit 1; }

# T1.5 waits on the outside precondition T9; trusting it makes no model call. Each word is its own argument:
# `opencode run` quotes an argument that contains a space, and the harness would read the quotes as part of it.
bun dev run --attach "$url" --dir "$target" -m "$model" --command task trust T9
bun dev run --attach "$url" --dir "$target" -m "$model" --command task task-formats/blend/release-notes.spec
# --continue opens the most recent root session: the one the run just started in.
bun dev attach "$url" --dir "$target" --continue
