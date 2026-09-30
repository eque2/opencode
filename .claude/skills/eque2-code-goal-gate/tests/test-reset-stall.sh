#!/usr/bin/env bash
# test-reset-stall.sh — reset-stall is a narrow, owner-protected recovery
# valve: it resets repetition accounting without changing the goal contract.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CANCEL="$TEST_DIR/../cancel.sh"
STATE="$TEST_DIR/../loop-state.sh"
WORK_DIR=""
PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
	[ -z "$WORK_DIR" ] || rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

pass() {
	PASS_COUNT=$((PASS_COUNT + 1))
	printf 'PASS  %s\n' "$1"
}

fail() {
	FAIL_COUNT=$((FAIL_COUNT + 1))
	printf 'FAIL  %s\n        %s\n' "$1" "$2"
}

assert_equals() {
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "expected [$2] got [$3]"
	fi
}

state_get() {
	bash "$STATE" get "$LOOP" "$1" 2>/dev/null
}

set_counter() {
	bash "$STATE" set "$LOOP" stall_hash repeated >/dev/null
	bash "$STATE" set "$LOOP" stall_count "$1" >/dev/null
	bash "$STATE" set "$LOOP" stall_raw_count "$1" >/dev/null
	bash "$STATE" set "$LOOP" stall_period_raw_count "$1" >/dev/null
	bash "$STATE" set "$LOOP" stall_window $'repeated\nrepeated' >/dev/null
	bash "$STATE" set "$LOOP" stall_warned_at 2026-07-27T09:00:00Z >/dev/null
}

run_reset() {
	GOAL_GATE_DIR="$GATE" "$@" bash "$CANCEL" reset-stall "${RESET_ARGS[@]}" >/dev/null 2>&1
	RUN_RC=$?
}

WORK_DIR="$(mktemp -d)" || exit 1
ROOT="$WORK_DIR/repo"
GATE="$ROOT/.goal-gate"
GOAL="$ROOT/X.goal"
mkdir -p -- "$GATE" "$GOAL"
LOOP="$GATE/_anon-reset.state"

for pair in \
	"status active" \
	"goal_folder $GOAL" \
	"acs_path $GOAL/ACs.md" \
	"iteration 12" \
	"claimed_by owner-a"; do
	bash "$STATE" set "$LOOP" "${pair%% *}" "${pair#* }" >/dev/null
done

# The owner can reset an active loop. Only repetition fields are changed.
set_counter 7
RECOVERY_TOKEN="$(printf 'a%.0s' {1..64})"
for pair in \
	"recovery_token $RECOVERY_TOKEN" \
	"recovery_hash repeated" \
	"recovery_owner owner-a" \
	"recovery_turn_id turn-reset" \
	"recovery_guard_hash guard-reset" \
	"recovery_ack_at 2026-07-27T09:01:00Z" \
	"recovery_credits 1" \
	"recovery_credit_applied 1"; do
	bash "$STATE" set "$LOOP" "${pair%% *}" "${pair#* }" >/dev/null
done
mkdir "$GATE/.recovery-ack.$RECOVERY_TOKEN"
RESET_ARGS=()
run_reset env GOAL_GATE_IDENTITY=owner-a
assert_equals "owner/reset-exits-zero" 0 "$RUN_RC"
assert_equals "owner/count-is-zero" 0 "$(state_get stall_count)"
assert_equals "owner/hash-cleared" "" "$(state_get stall_hash)"
assert_equals "owner/window-cleared" "" "$(state_get stall_window)"
assert_equals "owner/warning-cleared" "" "$(state_get stall_warned_at)"
assert_equals "owner/raw-history-is-preserved" 7 "$(state_get stall_raw_count)"
assert_equals "owner/period-count-is-cleared" "" "$(state_get stall_period_raw_count)"
assert_equals "owner/recovery-token-is-cleared" "" "$(state_get recovery_token)"
assert_equals "owner/recovery-guard-is-cleared" "" "$(state_get recovery_guard_hash)"
if [ ! -e "$GATE/.recovery-ack.$RECOVERY_TOKEN" ]; then
	pass "owner/recovery-marker-is-removed-after-state-reset"
else
	fail "owner/recovery-marker-is-removed-after-state-reset" "marker still exists"
fi
GOAL_GATE_DIR="$GATE" bash "$CANCEL" recovery-ack "$RECOVERY_TOKEN" >/dev/null 2>&1
assert_equals "owner/old-recovery-token-is-rejected" 4 "$?"
assert_equals "owner/status-remains-active" active "$(state_get status)"
assert_equals "owner/iteration-unchanged" 12 "$(state_get iteration)"
assert_equals "owner/criteria-path-unchanged" "$GOAL/ACs.md" "$(state_get acs_path)"
if [ -n "$(state_get stall_reset_at)" ] && [ "$(state_get stall_reset_from)" = 7 ]; then
	pass "owner/reset-is-audited"
else
	fail "owner/reset-is-audited" "missing or incorrect reset provenance"
fi

# An unknown caller cannot keep another conversation's loop alive by resetting
# its counter. `--force` is explicit and works in the current-directory form.
set_counter 6
RESET_ARGS=()
run_reset env
assert_equals "foreign/refuses-without-force" 3 "$RUN_RC"
assert_equals "foreign/count-is-unchanged" 6 "$(state_get stall_count)"
RESET_ARGS=(--force)
run_reset env
assert_equals "force/reset-exits-zero" 0 "$RUN_RC"
assert_equals "force/count-is-zero" 0 "$(state_get stall_count)"

# A reset never revives terminal history.
bash "$STATE" set "$LOOP" status stalled >/dev/null
set_counter 6
RESET_ARGS=()
run_reset env GOAL_GATE_IDENTITY=owner-a
assert_equals "terminal/refuses-to-revive" 1 "$RUN_RC"
assert_equals "terminal/count-is-unchanged" 6 "$(state_get stall_count)"

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
