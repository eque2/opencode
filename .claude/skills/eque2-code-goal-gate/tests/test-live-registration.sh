#!/usr/bin/env bash
# test-live-registration.sh — settles assumption A1 by firing the gate under a
# REAL agent session and checking its decision was honoured (T3.4).
#
# Every other suite in this directory drives the gate directly. This one is the
# only place the HOST is in the loop, and it exists because of the finding in
# live-evidence/README.md: Codex silently skips a hook it does not trust. The
# session ends normally, exit 0, no warning — so a gate can be perfectly
# installed and completely inert, and only an end-to-end run can tell.
#
# TWO MODES, and neither is a silent pass:
#
#   GOAL_GATE_LIVE=1   run a real agent session. Costs tokens and minutes.
#   (unset)            verify the RECORDED evidence of such a run is present
#                      and says what it must. A missing or gutted record FAILS.
#
# So the suite is green only where live proof exists, without re-billing a real
# session on every run.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${TEST_DIR}/../goal-gate-stop.sh"
STARTER="${TEST_DIR}/../pursue-goal.sh"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"
EVIDENCE="${TEST_DIR}/../live-evidence"

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

assert_equals() {
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "expected [$2] got [$3]"
	fi
}

# assert_records <name> <file> <regex>
assert_records() {
	if [ ! -f "$2" ]; then
		fail "$1" "no such evidence file: $2"
		return
	fi
	if grep -Eqi -- "$3" "$2"; then
		pass "$1"
	else
		fail "$1" "$(basename -- "$2") does not record: $3"
	fi
}

# ==========================================================================
# PART 1 — the recorded evidence (always checked)
# ==========================================================================

printf '\n--- recorded evidence ---\n'

CLAUDE_STATE="$EVIDENCE/claude-loop-state.txt"
CODEX_PAYLOAD="$EVIDENCE/codex-stop-payload.json"

if [ -d "$EVIDENCE" ]; then
	pass "evidence/directory-present"
else
	fail "evidence/directory-present" "no live-evidence directory — A1 is UNSETTLED, not merely unrun"
fi

assert_records "evidence/readme-names-both-agents" "$EVIDENCE/README.md" 'Codex'
assert_records "evidence/readme-records-silent-skip" "$EVIDENCE/README.md" 'did not fire|silent skip|silently skip'
assert_records "evidence/readme-states-its-limits" "$EVIDENCE/README.md" 'do NOT prove|does not prove'

# The Claude run: the gate fired, blocked, and was then honoured.
if [ -f "$CLAUDE_STATE" ]; then
	ITER="$(bash "$LOOP_STATE" get "$CLAUDE_STATE" iteration 2>/dev/null)"
	if [ -n "$ITER" ] && [ "$ITER" -gt 1 ] 2>/dev/null; then
		pass "evidence/claude-refusal-continued-the-session"
	else
		fail "evidence/claude-refusal-continued-the-session" \
			"iteration=$ITER — a single iteration proves the gate ran, not that a refusal was honoured"
	fi
	assert_equals "evidence/claude-permitted-only-when-done" "done" \
		"$(bash "$LOOP_STATE" get "$CLAUDE_STATE" acs_verdict 2>/dev/null)"
	assert_equals "evidence/claude-decision-recorded" "permitted" \
		"$(bash "$LOOP_STATE" get "$CLAUDE_STATE" decision 2>/dev/null)"
	assert_equals "evidence/claude-evidence-was-enforced" "0" \
		"$(bash "$LOOP_STATE" get "$CLAUDE_STATE" acs_ticked_without_evidence 2>/dev/null)"
	CLAIM="$(bash "$LOOP_STATE" get "$CLAUDE_STATE" claimed_at 2>/dev/null)"
	if [ -n "$CLAIM" ]; then
		pass "evidence/claude-claim-handshake-ran"
	else
		fail "evidence/claude-claim-handshake-ran" "no claimed_at — the gate never claimed the workstream"
	fi
else
	fail "evidence/claude-run-recorded" "no $CLAUDE_STATE"
fi

# The Codex payload: the real shape, carrying BOTH identities.
if [ -f "$CODEX_PAYLOAD" ]; then
	for field in session_id turn_id hook_event_name; do
		if jq -e --arg f "$field" 'has($f)' "$CODEX_PAYLOAD" >/dev/null 2>&1; then
			pass "evidence/codex-payload-has-$field"
		else
			fail "evidence/codex-payload-has-$field" "the recorded Codex payload lacks $field"
		fi
	done
else
	fail "evidence/codex-payload-recorded" "no $CODEX_PAYLOAD"
fi

# ==========================================================================
# PART 2 — the live run (opt-in)
# ==========================================================================

if [ "${GOAL_GATE_LIVE-}" != "1" ]; then
	printf '\n--- live run: NOT RUN (set GOAL_GATE_LIVE=1 to re-verify against a real session) ---\n'
	printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
	[ "$FAIL_COUNT" -eq 0 ]
	exit $?
fi

printf '\n--- live run ---\n'

AGENT_BIN="${GOAL_GATE_LIVE_AGENT:-claude}"
if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
	# An absent agent is a BLOCKER to surface, not a step to skip: the whole
	# point of this suite is that config alone proves nothing.
	fail "live/agent-available" "'$AGENT_BIN' is not installed, so the gate CANNOT be verified to fire here"
	printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 1
fi

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

PROJ="$WORK_DIR/project"
mkdir -p -- "$PROJ/.claude" "$PROJ/X.goal"

# The wrapper bounds the run. Without it a gate that refuses forever would block
# a real session for as long as the host is willing to keep going.
cat >"$PROJ/gate-wrapper.sh" <<EOF
#!/usr/bin/env bash
export GOAL_GATE_MAX_ITERATIONS=3
exec bash "$GATE" "\$@"
EOF
chmod +x "$PROJ/gate-wrapper.sh"

# Project-scoped registration: a real registration the host honours, without
# modifying any shared user configuration.
cat >"$PROJ/.claude/settings.json" <<EOF
{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"$PROJ/gate-wrapper.sh","timeout":120}]}]}}
EOF

printf '# Charter\n\nCreate the file the criterion names.\n' >"$PROJ/X.goal/goal.md"
cat >"$PROJ/X.goal/ACs.md" <<EOF
# Done when

- [ ] The file \`$PROJ/DONE.txt\` exists and contains \`ping\` — \`cat DONE.txt\`
      - explanation: not created yet.
EOF

if ! GOAL_GATE_ANCHOR="$PROJ" bash "$STARTER" "$PROJ/X.goal" >/dev/null 2>&1; then
	fail "live/loop-state-written" "the starter refused to bind the fixture folder"
	printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 1
fi
pass "live/loop-state-written"

(cd "$PROJ" && "$AGENT_BIN" -p "Read X.goal/ACs.md and satisfy the criterion. Then stop." \
	--permission-mode bypassPermissions </dev/null >"$WORK_DIR/session.log" 2>&1)
SESSION_RC=$?

# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
LIVE_STATE="$(ls "$PROJ"/.goal-gate/*.state 2>/dev/null | head -1)"

if [ -z "$LIVE_STATE" ]; then
	fail "live/gate-fired" "no loop state survived the session"
else
	CLAIMED="$(bash "$LOOP_STATE" get "$LIVE_STATE" claimed_at 2>/dev/null)"
	if [ -n "$CLAIMED" ]; then
		pass "live/gate-fired"
	else
		fail "live/gate-fired" "the gate never claimed the workstream — it did not run, or ran and was ignored"
	fi

	ITER="$(bash "$LOOP_STATE" get "$LIVE_STATE" iteration 2>/dev/null)"
	if [ -n "$ITER" ] && [ "$ITER" -gt 1 ] 2>/dev/null; then
		pass "live/refusal-continued-the-session"
	else
		fail "live/refusal-continued-the-session" "iteration=$ITER — no refusal was honoured"
	fi

	assert_equals "live/permitted-only-when-done" "done" \
		"$(bash "$LOOP_STATE" get "$LIVE_STATE" acs_verdict 2>/dev/null)"
	assert_equals "live/tick-carried-evidence" "0" \
		"$(bash "$LOOP_STATE" get "$LIVE_STATE" acs_ticked_without_evidence 2>/dev/null)"
fi

# The work was really done, not merely declared done.
if [ -f "$PROJ/DONE.txt" ] && grep -q ping "$PROJ/DONE.txt"; then
	pass "live/work-actually-happened"
else
	fail "live/work-actually-happened" "the criterion's artefact is absent — a tick without the work behind it"
fi

assert_equals "live/session-ended-cleanly" "0" "$SESSION_RC"

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
