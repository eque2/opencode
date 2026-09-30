#!/usr/bin/env bash
# test-codex-recovery.sh — Codex gets one acknowledged recovery credit for each
# unchanged progress state, without gaining an unlimited stall reset.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="$TEST_DIR/../goal-gate-stop.sh"
CANCEL="$TEST_DIR/../cancel.sh"
LOOP_STATE="$TEST_DIR/../loop-state.sh"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-codex-recovery.XXXXXX")"
PASS_COUNT=0
FAIL_COUNT=0
TEST_PART="${RECOVERY_TEST_PART:-all}"

cleanup() {
	chmod -R u+rwx "$WORK_DIR" 2>/dev/null || true
	rm -rf -- "$WORK_DIR"
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

new_goal() {
	local goal
	goal="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	mkdir -p "$goal/.goal-gate"
	cat >"$goal/ACs.md" <<'EOF'
- [x] The checked criterion has evidence — `scripts/check.sh`
      - evidence: `bash scripts/check.sh` → exit 0
- [ ] The remaining task is incomplete — `scripts/build.sh`
      - explanation: the build has not run.
EOF
	printf '%s' "$goal"
}

run_gate() {
	local goal="$1" payload="$2"
	RUN_OUT="$(printf '%s' "$payload" | env "GOAL_GATE_DIR=$goal/.goal-gate" \
		"GOAL_GATE_STALL_MAX=${GATE_STALL_MAX:-8}" bash "$GATE" 2>"$WORK_DIR/stderr")"
	RUN_CODE=$?
	RUN_ERR="$(cat "$WORK_DIR/stderr")"
}

run_ack() {
	local goal="$1" token="$2"
	ACK_OUT="$(env "GOAL_GATE_DIR=$goal/.goal-gate" \
		bash "$CANCEL" recovery-ack "$token" 2>"$WORK_DIR/ack-stderr")"
	ACK_CODE=$?
	ACK_ERR="$(cat "$WORK_DIR/ack-stderr")"
}

# state <goal-folder> <field> — a field of the single loop file.
#
# `find … | head -1` ALONE IS ORDER-DEPENDENT and must not be used bare. A gate
# directory can hold more than one `.state` file — a live loop beside a retired
# one, a restarted run beside the run it replaced — and `find` enumerates in no
# order this test controls, so the head would be whichever the filesystem
# offered. Every other suite in this project guards the same helper by requiring
# exactly one file; this one did not, so it does now. Reading a field off the
# wrong loop is the kind of failure that reports a wrong VALUE rather than an
# error, which is the expensive kind.
state() {
	local goal="$1" field="$2" file n
	n="$(find "$goal/.goal-gate" -maxdepth 1 -name '*.state' -type f | wc -l | tr -d ' ')"
	if [ "$n" != "1" ]; then
		printf '<%s state files>' "$n"
		return
	fi
	file="$(find "$goal/.goal-gate" -maxdepth 1 -name '*.state' -type f | head -1)"
	bash "$LOOP_STATE" get "$file" "$field" 2>/dev/null || true
}

assert_block() {
	local name="$1"
	if [ "$RUN_CODE" -eq 0 ] && printf '%s' "$RUN_OUT" | jq -e '.decision == "block"' >/dev/null 2>&1; then
		pass "$name"
	else
		fail "$name" "expected a block decision; code=$RUN_CODE output=[$RUN_OUT] error=[$RUN_ERR]"
	fi
}

assert_terminal() {
	local name="$1"
	if [ "$RUN_CODE" -eq 0 ] && ! printf '%s' "$RUN_OUT" | jq -e 'has("decision")' >/dev/null 2>&1; then
		pass "$name"
	else
		fail "$name" "expected a terminal non-completion; code=$RUN_CODE output=[$RUN_OUT] error=[$RUN_ERR]"
	fi
}

assert_equals() {
	local name="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		pass "$name"
	else
		fail "$name" "expected=[$expected] actual=[$actual]"
	fi
}

assert_ack_exit() {
	local name="$1" expected="$2"
	if [ "$ACK_CODE" -eq "$expected" ]; then
		pass "$name"
	else
		fail "$name" "expected exit $expected; code=$ACK_CODE output=[$ACK_OUT] error=[$ACK_ERR]"
	fi
}

printf '== Codex recovery guard ==\n'
GATE_STALL_MAX=2

if [ "$TEST_PART" = "all" ] || [ "$TEST_PART" = "core" ]; then
GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"codex-recovery","turn_id":"turn-1","stop_hook_active":false,"last_assistant_message":"done"}'
assert_block "codex/first-stop-blocks"
case "$RUN_OUT" in
*'Codex recovery:'*'Do not declare LOOP_BLOCKED'*'recovery-ack'*) pass "codex/first-stop-gives-a-model-visible-recovery-instruction" ;;
*) fail "codex/first-stop-gives-a-model-visible-recovery-instruction" "output=[$RUN_OUT]" ;;
esac
TOKEN="$(state "$GOAL" recovery_token)"
case "$TOKEN" in
'' | *[!0-9a-f]*) fail "codex/first-stop-records-a-safe-token" "token=[$TOKEN]" ;;
*) pass "codex/first-stop-records-a-safe-token" ;;
esac
assert_equals "codex/first-stop-raw-count-is-one" 1 "$(state "$GOAL" stall_raw_count)"
assert_equals "codex/first-stop-effective-count-is-one" 1 "$(state "$GOAL" stall_count)"

run_ack "$GOAL" "$(printf '0%.0s' {1..64})"
assert_ack_exit "codex/a-foreign-token-is-rejected" 4

ACS_BEFORE="$(shasum -a 256 "$GOAL/ACs.md" | cut -d' ' -f1)"
ITERATION_BEFORE="$(state "$GOAL" iteration)"
run_ack "$GOAL" "$TOKEN"
assert_ack_exit "codex/the-issued-token-is-accepted" 0
assert_equals "codex/ack-does-not-change-criteria" "$ACS_BEFORE" "$(shasum -a 256 "$GOAL/ACs.md" | cut -d' ' -f1)"
assert_equals "codex/ack-does-not-change-iteration" "$ITERATION_BEFORE" "$(state "$GOAL" iteration)"
STATUS_AFTER_ACK="$(state "$GOAL" status)"
case "$STATUS_AFTER_ACK" in
stalled | cancelled | complete | LOOP_BLOCKED | LOOP_PARTIAL) fail "codex/ack-keeps-the-loop-active" "status=[$STATUS_AFTER_ACK]" ;;
*) pass "codex/ack-keeps-the-loop-active" ;;
esac

run_ack "$GOAL" "$TOKEN"
assert_ack_exit "codex/the-token-is-single-use" 4

run_gate "$GOAL" '{"session_id":"codex-recovery","turn_id":"turn-2","stop_hook_active":true,"last_assistant_message":"done"}'
assert_block "codex/second-unchanged-stop-keeps-working"
assert_equals "codex/ack-discounts-one-stop" 1 "$(state "$GOAL" stall_count)"
assert_equals "codex/raw-history-keeps-both-stops" 2 "$(state "$GOAL" stall_raw_count)"
assert_equals "codex/period-history-keeps-both-stops" 2 "$(state "$GOAL" stall_period_raw_count)"
assert_equals "codex/one-credit-is-recorded" 1 "$(state "$GOAL" recovery_credits)"

run_gate "$GOAL" '{"session_id":"codex-recovery","turn_id":"turn-3","stop_hook_active":true,"last_assistant_message":"done"}'
assert_block "codex/third-unchanged-stop-still-blocks"
assert_equals "codex/a-second-credit-is-not-created" 2 "$(state "$GOAL" stall_count)"
assert_equals "codex/raw-history-reaches-three" 3 "$(state "$GOAL" stall_raw_count)"

run_gate "$GOAL" '{"session_id":"codex-recovery","turn_id":"turn-4","stop_hook_active":true,"last_assistant_message":"done"}'
assert_block "codex/fourth-unchanged-stop-still-blocks"
run_gate "$GOAL" '{"session_id":"codex-recovery","turn_id":"turn-5","stop_hook_active":true,"last_assistant_message":"done"}'
assert_terminal "codex/the-standard-terminal-eventually-ends-the-loop"
assert_equals "codex/terminal-uses-the-normal-repeat-kind" repeat "$(state "$GOAL" stall_kind)"
fi

# Measurable progress starts a new recovery period with a different token.
if [ "$TEST_PART" = "all" ] || [ "$TEST_PART" = "progress" ]; then
GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"codex-progress","turn_id":"progress-1","stop_hook_active":false,"last_assistant_message":"done"}'
TOKEN_ONE="$(state "$GOAL" recovery_token)"
run_ack "$GOAL" "$TOKEN_ONE"
assert_ack_exit "progress/first-period-ack-is-accepted" 0
run_gate "$GOAL" '{"session_id":"codex-progress","turn_id":"progress-2","stop_hook_active":true,"last_assistant_message":"done"}'
assert_equals "progress/first-period-credit-applies" 1 "$(state "$GOAL" stall_count)"
# shellcheck disable=SC2016 # Literal Markdown command in the fixture.
printf '%s\n' '- [ ] A new measurable task is incomplete — `scripts/new.sh`' \
	'      - explanation: the new task has not run.' >>"$GOAL/ACs.md"
run_gate "$GOAL" '{"session_id":"codex-progress","turn_id":"progress-3","stop_hook_active":true,"last_assistant_message":"done"}'
TOKEN_TWO="$(state "$GOAL" recovery_token)"
assert_equals "progress/raw-history-remains-monotonic" 3 "$(state "$GOAL" stall_raw_count)"
assert_equals "progress/new-period-restarts-only-the-period-count" 1 "$(state "$GOAL" stall_period_raw_count)"
if [ -n "$TOKEN_TWO" ] && [ "$TOKEN_ONE" != "$TOKEN_TWO" ]; then
	pass "progress/new-period-gets-a-new-token"
else
	fail "progress/new-period-gets-a-new-token" "first=[$TOKEN_ONE] second=[$TOKEN_TWO]"
fi
run_ack "$GOAL" "$TOKEN_ONE"
assert_ack_exit "progress/the-expired-token-is-rejected" 4
run_ack "$GOAL" "$TOKEN_TWO"
assert_ack_exit "progress/the-new-token-is-accepted" 0

# Work that changes before the acknowledgment expires the token immediately.
GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"codex-expiry","turn_id":"expiry-1","stop_hook_active":false,"last_assistant_message":"done"}'
EXPIRING_TOKEN="$(state "$GOAL" recovery_token)"
# shellcheck disable=SC2016 # Literal Markdown command in the fixture.
printf '%s\n' '- [ ] Work changed before acknowledgment — `scripts/change.sh`' \
	'      - explanation: the changed work has not run.' >>"$GOAL/ACs.md"
run_ack "$GOAL" "$EXPIRING_TOKEN"
assert_ack_exit "progress/a-token-expires-before-the-next-stop-when-work-changes" 4
fi

# Without an acknowledgment Codex still uses the normal threshold, not the
# removed two-Stop shortcut.
if [ "$TEST_PART" = "all" ] || [ "$TEST_PART" = "policy" ]; then
GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"codex-no-ack","turn_id":"no-ack-1","stop_hook_active":false,"last_assistant_message":"done"}'
assert_block "no-ack/first-stop-blocks"
assert_equals "no-ack/first-stop-raw-count-is-one" 1 "$(state "$GOAL" stall_raw_count)"
run_gate "$GOAL" '{"session_id":"codex-no-ack","turn_id":"no-ack-2","stop_hook_active":true,"last_assistant_message":"done"}'
assert_block "no-ack/second-stop-does-not-terminal"
assert_equals "no-ack/second-stop-raw-count-is-two" 2 "$(state "$GOAL" stall_raw_count)"
run_gate "$GOAL" '{"session_id":"codex-no-ack","turn_id":"no-ack-3","stop_hook_active":true,"last_assistant_message":"done"}'
assert_block "no-ack/third-stop-reaches-only-the-warning"
assert_equals "no-ack/third-stop-raw-count-is-three" 3 "$(state "$GOAL" stall_raw_count)"
assert_equals "no-ack/third-stop-is-the-standard-warning" refused_stall_warning "$(state "$GOAL" decision)"
run_gate "$GOAL" '{"session_id":"codex-no-ack","turn_id":"no-ack-4","stop_hook_active":true,"last_assistant_message":"done"}'
assert_terminal "no-ack/fourth-stop-uses-the-standard-terminal"
assert_equals "no-ack/terminal-is-not-codex-specific" repeat "$(state "$GOAL" stall_kind)"

# Atomic capability consumption accepts exactly one concurrent caller.
GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"codex-concurrent","turn_id":"concurrent-1","stop_hook_active":false,"last_assistant_message":"done"}'
CONCURRENT_TOKEN="$(state "$GOAL" recovery_token)"
env "GOAL_GATE_DIR=$GOAL/.goal-gate" bash "$CANCEL" recovery-ack "$CONCURRENT_TOKEN" \
	>"$WORK_DIR/concurrent-1.out" 2>"$WORK_DIR/concurrent-1.err" &
PID_ONE=$!
env "GOAL_GATE_DIR=$GOAL/.goal-gate" bash "$CANCEL" recovery-ack "$CONCURRENT_TOKEN" \
	>"$WORK_DIR/concurrent-2.out" 2>"$WORK_DIR/concurrent-2.err" &
PID_TWO=$!
wait "$PID_ONE"; RC_ONE=$?
wait "$PID_TWO"; RC_TWO=$?
if { [ "$RC_ONE" -eq 0 ] && [ "$RC_TWO" -eq 4 ]; } || \
	{ [ "$RC_ONE" -eq 4 ] && [ "$RC_TWO" -eq 0 ]; }; then
	pass "concurrent/exactly-one-acknowledgment-succeeds"
else
	fail "concurrent/exactly-one-acknowledgment-succeeds" "rc_one=$RC_ONE rc_two=$RC_TWO"
fi

run_gate "$GOAL" '{"session_id":"codex-concurrent","turn_id":"concurrent-2","stop_hook_active":true,"last_assistant_message":"done"}'
STATUS_OUT="$(env "GOAL_GATE_DIR=$GOAL/.goal-gate" bash "$CANCEL" status 2>&1)"
case "$STATUS_OUT" in
*'raw Stop count: 2; acknowledged recovery credits: 1'*) pass "status/shows-raw-count-and-credit" ;;
*) fail "status/shows-raw-count-and-credit" "output=[$STATUS_OUT]" ;;
esac

# A turn ID alone identifies a Codex-shaped request, but it has no stable
# session binding. It must keep the general gate policy, not enter recovery.
GOAL="$(new_goal)"
run_gate "$GOAL" '{"turn_id":"turn-partial-1","last_assistant_message":"done"}'
assert_block "codex-partial/first-stop-blocks"
case "$RUN_OUT" in
*'Codex recovery:'*) fail "codex-partial/first-stop-has-no-recovery-instruction" "output=[$RUN_OUT]" ;;
*) pass "codex-partial/first-stop-has-no-recovery-instruction" ;;
esac
run_gate "$GOAL" '{"turn_id":"turn-partial-2","last_assistant_message":"done"}'
assert_block "codex-partial/second-unchanged-stop-keeps-the-existing-policy"
if [ "$(state "$GOAL" status)" != "stalled" ]; then
	pass "codex-partial/second-stop-is-not-terminal"
else
	fail "codex-partial/second-stop-is-not-terminal" "decision=[$(state "$GOAL" decision)]"
fi

GOAL="$(new_goal)"
run_gate "$GOAL" '{"session_id":"claude-recovery"}'
assert_block "claude/first-stop-still-blocks"
case "$RUN_OUT" in
*'Codex recovery:'*) fail "claude/first-stop-has-no-codex-instruction" "output=[$RUN_OUT]" ;;
*) pass "claude/first-stop-has-no-codex-instruction" ;;
esac
run_gate "$GOAL" '{"session_id":"claude-recovery"}'
assert_block "claude/second-unchanged-stop-keeps-the-existing-policy"
if [ "$(state "$GOAL" status)" != "stalled" ]; then
	pass "claude/second-stop-is-not-terminal"
else
	fail "claude/second-stop-is-not-terminal" "decision=[$(state "$GOAL" decision)]"
fi
fi

unset GATE_STALL_MAX

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
