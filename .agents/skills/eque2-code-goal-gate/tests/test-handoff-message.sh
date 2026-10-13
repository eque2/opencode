#!/usr/bin/env bash
# test-handoff-message.sh — conformance suite for the preparation hand-off (T4.5).
#
# The hand-off is prose a model emits, so what is testable is the INSTRUCTION:
# that the skill documents tell the run to name the folder it actually produced,
# to send the reader to a fresh context, to invoke `pursue-goal` on that path,
# and NOT to emit a hand-off when no folder was produced. A missing instruction
# is a hand-off that will not happen.
#
# The path-rendering rule is executable, so it IS executed: a folder whose name
# carries spaces and non-ASCII characters must survive as a usable parameter.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL="${TEST_DIR}/../../eque2-code-prepare-goal/SKILL.md"
PHASES="${TEST_DIR}/../../eque2-code-prepare-goal/references/phases.md"
STARTER="${TEST_DIR}/../pursue-goal.sh"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"

PASS_COUNT=0
FAIL_COUNT=0
WORK_DIR=""

cleanup() {
	if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
		chmod -R u+rwx "$WORK_DIR" 2>/dev/null || true
		rm -rf -- "$WORK_DIR"
	fi
}
trap cleanup EXIT

pass() {
	PASS_COUNT=$((PASS_COUNT + 1))
	printf 'PASS  %s\n' "$1"
}

fail() {
	FAIL_COUNT=$((FAIL_COUNT + 1))
	printf 'FAIL  %s\n' "$1"
	printf '        %s\n' "$2"
}

# assert_states <name> <file> <regex> — the document carries the instruction.
assert_states() {
	local name="$1" file="$2" pattern="$3"
	if [ ! -f "$file" ]; then
		fail "$name" "no such document: $file"
		return
	fi
	if grep -Eqi -- "$pattern" "$file"; then
		pass "$name"
	else
		fail "$name" "$(basename -- "$file") does not state: $pattern"
	fi
}

# --------------------------------------------------------------------------
# 1. The hand-off phase is documented at all
# --------------------------------------------------------------------------

assert_states "phase/exists" "$PHASES" 'Phase H'
assert_states "phase/routed-from-skill" "$SKILL" 'H Hand-off|Phase H'

# --------------------------------------------------------------------------
# 2. Happy path — it names the produced folder and the starter command
# --------------------------------------------------------------------------

assert_states "happy/invokes-pursue-goal" "$PHASES" 'pursue-goal'
assert_states "happy/names-the-real-path" "$PHASES" 'path this run actually produced|actually created'
assert_states "happy/forbids-example-paths" "$PHASES" 'never emit a template'

# --------------------------------------------------------------------------
# 3. The fresh-context separation — the reason the hand-off exists
# --------------------------------------------------------------------------

assert_states "context/fresh-context-required" "$PHASES" 'FRESH context|fresh context'
assert_states "context/does-not-self-invoke" "$PHASES" 'do not invoke .pursue-goal. yourself'
assert_states "context/skill-states-separation" "$SKILL" 'never executes the charter and never starts the loop'

# --------------------------------------------------------------------------
# 4. Empty/null — a run that produced nothing invites nothing
# --------------------------------------------------------------------------

assert_states "empty/no-folder-no-handoff" "$PHASES" 'produced no folder emits NO hand-off|produced no folder emits no hand-off'
assert_states "empty/blocked-run-reports" "$PHASES" 'blocked, or Phase E did not land'
assert_states "empty/skill-records-the-rule" "$SKILL" 'folder emits no hand-off'

# --------------------------------------------------------------------------
# 5. State transitions — a re-run names the folder as it now stands
# --------------------------------------------------------------------------

assert_states "state/rerun-names-current-folder" "$PHASES" 'never a stale'

# --------------------------------------------------------------------------
# 6. Boundary — an awkward path is EXECUTED, not just documented
# --------------------------------------------------------------------------

assert_states "boundary/quoting-rule-documented" "$PHASES" 'spaces or non-ASCII'

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

ANCHOR="$WORK_DIR/tree"
AWKWARD="$ANCHOR/a folder with spaces — and ünicode.goal"
mkdir -p -- "$AWKWARD"
printf '# charter\n' >"$AWKWARD/goal.md"
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf -- '- [ ] The thing works — `run.sh`\n      - explanation: not built yet.\n' >"$AWKWARD/ACs.md"

OUT="$(GOAL_GATE_SKIP_REGISTRATION_CHECK=1 GOAL_GATE_ANCHOR="$ANCHOR" \
	bash "$STARTER" "$AWKWARD" 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then
	fail "boundary/awkward-path-usable" "the produced path was not usable as a parameter (exit $RC): [$OUT]"
else
	# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
	LOOP="$(ls "$ANCHOR"/.goal-gate/*.state 2>/dev/null | head -1)"
	BOUND="$(bash "$LOOP_STATE" get "$LOOP" goal_folder 2>/dev/null)"
	if [ "$BOUND" = "$AWKWARD" ]; then
		pass "boundary/awkward-path-usable"
	else
		fail "boundary/awkward-path-usable" "expected [$AWKWARD] got [$BOUND]"
	fi
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
