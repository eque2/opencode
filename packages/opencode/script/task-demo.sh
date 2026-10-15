#!/usr/bin/env bash
# Seed the current folder as a /task demo and open this opencode fork on it: the release-notes seed plus the two
# blend trees and every `example-*.spec` folder, committed on `main`, with the seed's dependencies installed. The same
# layout as the conformance workspace (test/task-harness/arms/workspace.ts). TASK_DEMO_NO_EXEC=1 seeds and commits
# only: no install, no TUI (the test of this script uses it).
#
#   cd <empty folder, or an earlier demo folder> && bash <opencode>/packages/opencode/script/task-demo.sh
#
# Then type in the TUI:  /task trust T9   and then   /task task-formats/blend/release-notes.spec
# The live checks:       /task task-formats/blend/example-scenarios.spec   or   /task task-formats/blend/example-cascade.spec
# The run uses the TUI's model and spends real tokens (the spike measured about $1–3 and at most 30 minutes).
# ponytail: an earlier demo folder is wiped and seeded again, but opencode's database keeps its runs by folder, so a
# run there that never ended resumes against the new seed. Use a new folder if the earlier run did not end.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
target="$(pwd)"

if [ -n "$(ls -A)" ]; then
  # Wipe only a folder this script seeded: its own git repository, first commit "seed", with the demo spec.
  if [ "$(git rev-parse --show-toplevel 2>/dev/null)" != "$target" ] ||
    [ "$(git log --reverse --format=%s 2>/dev/null | head -1)" != "seed" ] ||
    [ ! -d task-formats/blend/release-notes.spec ]; then
    echo "task-demo: $target is not empty and is not an earlier demo; run it in a new, empty folder" >&2
    exit 1
  fi
  echo "task-demo: wiping the earlier demo in $target"
  find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi

cp -R "$root/packages/opencode/test/task-harness/release-notes-repo/." .
mkdir -p task-formats/blend
for tree in release-notes.spec provider-ordering-admin.spec "$root"/task-formats/blend/example-*.spec; do
  cp -R "$root/task-formats/blend/$(basename "$tree")" task-formats/blend/
done

git init -q -b main
git add -A
git commit -q -m seed

echo "task-demo: ready. In the TUI, type:  /task trust T9   and then   /task task-formats/blend/release-notes.spec"
echo "task-demo: the live checks:  /task task-formats/blend/example-scenarios.spec   and   /task task-formats/blend/example-cascade.spec"
if [ "${TASK_DEMO_NO_EXEC:-}" = "1" ]; then exit 0; fi
# After the commit: node_modules is in the seed's .gitignore, so the checkout stays clean, which /task requires.
bun install --frozen-lockfile
cd "$root"
exec bun dev "$target"
