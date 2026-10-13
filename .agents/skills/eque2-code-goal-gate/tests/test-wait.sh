#!/usr/bin/env bash
# test-wait.sh — executable conformance suite for goal-gate-stop.sh's
# SANCTIONED WAIT (T2.5).
#
# The mechanism: a loop legitimately waiting on an external result (a CI run, a
# deploy, a human) may declare that wait, and stall accounting is SUSPENDED for
# its duration — otherwise a loop doing exactly the right thing gets killed for
# not changing.
#
# The danger is the mirror image, and it is why every bound here is asserted:
# a wait that can be re-declared indefinitely freezes stall accounting forever
# while never permitting completion, so the loop satisfies BOTH safety
# mechanisms and lives forever (review finding R7). A wait must therefore be
# bounded in aggregate, not merely per declaration.
#
# Three properties, none of which may be traded for another:
#
#   1. A valid wait SUSPENDS stall accounting.
#   2. A wait NEVER permits completion. It is not a pass, and not a shortcut to
#      one — every waiting turn still refuses.
#   3. Every wait is BOUNDED: per declaration (the clamp) and in aggregate
#      across the loop (R7's 24h ceiling).
#
# On bad input the rule is REJECT AND REPORT, never coerce. The ancestor
# stripped non-digits from its deadline, turning `abc123def` into a plausible
# number and `-5` into `5` — input mangled into a value nobody wrote. And an
# over-long deadline was silently treated as "no wait", so a declaration the
# operator believed was in force simply was not.
#
# Deadlines are EPOCH SECONDS, deliberately. Parsing human date strings would
# mean `date -d` (GNU) or `date -j -f` (BSD) and a portability failure would
# resolve to either a silent freeze or a silent no-wait — both unacceptable.
# A non-numeric declaration is rejected and reported, which covers a GNU-style
# invocation arriving on BSD userland by construction rather than by luck.
#
# Observables only: stdout, stderr, exit status, and the loop-state file read
# through loop-state.sh, its own public reader.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

# shellcheck disable=SC2016
# Backticks are LITERAL ACs.md markup inside fixture text, never substitution.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_MODULE:-${TEST_DIR}/../goal-gate-stop.sh}"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"

PASS_COUNT=0
FAIL_COUNT=0
WORK_DIR=""

# shellcheck disable=SC2329  # invoked indirectly, by the EXIT trap below.
cleanup() {
	if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
		chmod -R u+rwx "$WORK_DIR" 2>/dev/null || true
		rm -rf -- "$WORK_DIR"
	fi
}
trap cleanup EXIT

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-wait.XXXXXX")"
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

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

new_goal() {
	local d
	d="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	d="$(cd -- "$d" && pwd -P)"
	mkdir -p "$d/.goal-gate"
	printf '%s' "$d"
}

RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0

gate_run() {
	local goal="$1" payload="$2"
	shift 2
	local outf errf
	outf="$(mktemp "$WORK_DIR/out.XXXXXX")"
	errf="$(mktemp "$WORK_DIR/err.XXXXXX")"

	printf '%s' "$payload" |
		env "GOAL_GATE_DIR=$goal/.goal-gate" "$@" bash "$GATE" >"$outf" 2>"$errf"
	RUN_STATUS=$?
	RUN_OUT="$(cat -- "$outf")"
	RUN_ERR="$(cat -- "$errf")"
	rm -f -- "$outf" "$errf"
}

assert_refuses() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0 (hook contract), got $RUN_STATUS (err=[$RUN_ERR])"
		return 1
	fi
	case "$RUN_OUT" in
	*'"decision":"block"'*) pass "$name" ;;
	*)
		fail "$name" "expected a block decision on stdout, got [$RUN_OUT]"
		return 1
		;;
	esac
	return 0
}

# A turn is allowed to end when stdout carries no `decision` — not when stdout is
# empty. The gate also emits a user-visible `systemMessage` on the paths that end
# a loop; a systemMessage cannot hold a turn, only a decision can.
assert_terminal() {
	local name="$1"
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "expected no decision on stdout (terminal), got [$RUN_OUT]"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'NON-COMPLETION'*) pass "$name" ;;
	*)
		fail "$name" "no terminal non-completion reported (err=[$RUN_ERR])"
		return 1
		;;
	esac
	return 0
}

assert_err_mentions() {
	local name="$1" needle="$2"
	case "$RUN_ERR" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "stderr did not mention [$needle]: [$RUN_ERR]" ;;
	esac
}

# assert_err_mentions_ci <name> <needle> — case-insensitive. For assertions
# about WHETHER something was reported rather than how it was worded: the gate
# shouts CLAMPED, and a case-sensitive match would fail a correct gate over its
# capitalisation.
assert_err_mentions_ci() {
	local name="$1" needle haystack
	needle="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
	haystack="$(printf '%s' "$RUN_ERR" | tr '[:upper:]' '[:lower:]')"
	case "$haystack" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "stderr did not mention [$2] in any case: [$RUN_ERR]" ;;
	esac
}

assert_not_permitted() {
	local name="$1"
	case "$RUN_ERR" in
	*'PERMIT:'*) fail "$name" "a wait permitted completion (err=[$RUN_ERR])" ;;
	*) pass "$name" ;;
	esac
}

# loop_file <goal-folder> — path of the single .state file, or a marker.
#
# The "exactly one" guard is what makes this order-independent, and it matters
# more now than it did: a gate directory can hold a live loop beside a retired
# one, and `find` enumerates in no order this suite controls. A bare
# `find … | head -1` would silently read a field off whichever file the
# filesystem offered first. The marker string makes a multi-file directory an
# obvious failure instead of a wrong value.
loop_file() {
	local n f
	n="$(find "$1/.goal-gate" -maxdepth 1 -name '*.state' | wc -l | tr -d ' ')"
	if [ "$n" != "1" ]; then
		printf '<%s state files>' "$n"
		return
	fi
	f="$(find "$1/.goal-gate" -maxdepth 1 -name '*.state' | head -1)"
	printf '%s' "$f"
}

state_field() {
	bash "$LOOP_STATE" get "$(loop_file "$1")" "$2" 2>/dev/null || printf ''
}

assert_no_record() {
	if [ -e "$2/.goal-gate/completion-record.md" ]; then
		fail "$1" "a completion record was written on a waiting path"
	else
		pass "$1"
	fi
}

# declare_wait <goal> <content> — write the wait declaration verbatim.
declare_wait() {
	printf '%s' "$2" >"$1/.goal-gate/WAIT"
}

now_epoch() { date +%s; }

write_unmet() {
	cat >"$1/ACs.md" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
- [ ] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - explanation: waiting on the CI run that exercises it
EOF
}

write_all_met() {
	cat >"$1/ACs.md" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
EOF
}

printf '== goal-gate sanctioned wait (T2.5) conformance suite ==\n'
printf 'gate: %s\n\n' "$GATE"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite (the gate refuses without it).\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: a valid wait suspends stall accounting, still refuses --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"

# Threshold 2, so WITHOUT the wait the third identical turn would be terminal.
for i in 1 2 3 4; do
	gate_run "$GOAL" '{"session_id":"wait1"}' "GOAL_GATE_STALL_MAX=2"
	assert_refuses "happy/turn-$i-still-refuses-while-waiting"
	assert_not_permitted "happy/turn-$i-does-not-permit"
done

assert_no_record "happy/a-wait-writes-no-completion-record" "$GOAL"
assert_equals "happy/the-wait-is-recorded-as-active" "active" "$(state_field "$GOAL" wait_state)"

case "$(state_field "$GOAL" decision)" in
stalled) fail "happy/a-declared-wait-is-not-stalled" "the loop stalled despite a valid wait" ;;
*) pass "happy/a-declared-wait-is-not-stalled" ;;
esac

assert_err_mentions "happy/the-wait-is-reported-not-silent" "wait"

# A silent wait is indistinguishable from a dead loop, so the heartbeat has to
# keep going. Without this, the liveness window would expire mid-wait and
# another conversation could reclaim a workstream that is working correctly.
HB="$(cat "$GOAL"/.goal-gate/*.claim.*/heartbeat 2>/dev/null | head -1)"
if [ -n "$HB" ]; then
	pass "happy/heartbeats-continue-during-a-wait"
else
	pass "happy/heartbeats-continue-during-a-wait (self-bound: no claim dir)"
fi

# ===========================================================================
printf -- '-- 2. Expiry and removal restore normal accounting --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) - 60))" # already past

gate_run "$GOAL" '{"session_id":"exp1"}' "GOAL_GATE_STALL_MAX=2"
assert_refuses "expiry/an-expired-wait-refuses-normally"
assert_equals "expiry/an-expired-wait-is-recorded-as-expired" "expired" "$(state_field "$GOAL" wait_state)"
assert_err_mentions "expiry/the-expiry-is-reported" "wait"

# Accounting is live again, so the terminal stall must now be reachable. The
# threshold only warns; the loop ends at twice it, so three further turns.
gate_run "$GOAL" '{"session_id":"exp1"}' "GOAL_GATE_STALL_MAX=2"
gate_run "$GOAL" '{"session_id":"exp1"}' "GOAL_GATE_STALL_MAX=2"
gate_run "$GOAL" '{"session_id":"exp1"}' "GOAL_GATE_STALL_MAX=2"
assert_terminal "expiry/after-expiry-the-loop-can-stall-again"

# Removal mid-loop restores accounting IMMEDIATELY, not at the next expiry.
GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"
gate_run "$GOAL" '{"session_id":"rm1"}' "GOAL_GATE_STALL_MAX=2"
assert_refuses "removal/waiting-turn-refuses"
rm -f "$GOAL/.goal-gate/WAIT"
gate_run "$GOAL" '{"session_id":"rm1"}' "GOAL_GATE_STALL_MAX=2"
assert_equals "removal/removing-the-declaration-restores-accounting" "none" "$(state_field "$GOAL" wait_state)"

# An absent declaration is the ordinary case and must be silent about waiting.
GOAL="$(new_goal)"
write_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"none1"}' "GOAL_GATE_STALL_MAX=5"
assert_refuses "absent/no-declaration-means-normal-accounting"
assert_equals "absent/no-declaration-records-none" "none" "$(state_field "$GOAL" wait_state)"

# ===========================================================================
printf -- '-- 3. Bad input is REJECTED and REPORTED, never coerced --\n'
# ===========================================================================
#
# The ancestor stripped non-digits, so `abc123def` became 123 and `-5` became 5
# — a deadline nobody wrote, silently honoured. Each of these must be refused
# as a declaration AND leave accounting running normally.

for bad in "abc" "12abc34" "-5" "3.7" "" "   " "+2 hours" "2026-07-20T10:00:00" "99999999999999999999"; do
	GOAL="$(new_goal)"
	write_unmet "$GOAL"
	declare_wait "$GOAL" "$bad"
	gate_run "$GOAL" '{"session_id":"bad1"}' "GOAL_GATE_STALL_MAX=5"

	label="$(printf '%s' "$bad" | tr -c 'a-zA-Z0-9' '-' | cut -c1-20)"
	[ -n "$label" ] || label="empty"

	assert_refuses "badinput/${label}/still-refuses"

	case "$(state_field "$GOAL" wait_state)" in
	rejected) pass "badinput/${label}/is-rejected-not-honoured" ;;
	*) fail "badinput/${label}/is-rejected-not-honoured" "wait_state=[$(state_field "$GOAL" wait_state)] for input [$bad]" ;;
	esac

	# The decisive one: rejected input must not have become a NUMBER.
	case "$(state_field "$GOAL" wait_deadline)" in
	'' | '<none>') pass "badinput/${label}/no-deadline-was-invented" ;;
	*) fail "badinput/${label}/no-deadline-was-invented" "a deadline [$(state_field "$GOAL" wait_deadline)] was derived from [$bad]" ;;
	esac
done

# A rejected declaration is REPORTED — the operator believes a wait is in force
# and must be told it is not.
assert_err_mentions "badinput/the-rejection-is-reported" "wait"

# ===========================================================================
printf -- '-- 4. The clamp: an absurd deadline is clamped AND reported --\n'
# ===========================================================================
#
# The ancestor silently treated an over-long deadline as "no wait". Silence is
# the defect: the operator believes the loop is waiting, and it is not.

GOAL="$(new_goal)"
write_unmet "$GOAL"
FAR="$(($(now_epoch) + 400 * 24 * 3600))" # ~400 days out
declare_wait "$GOAL" "$FAR"
gate_run "$GOAL" '{"session_id":"clamp1"}' "GOAL_GATE_STALL_MAX=5"

assert_refuses "clamp/an-absurd-deadline-still-refuses"
assert_equals "clamp/an-absurd-deadline-is-clamped-not-discarded" "active" "$(state_field "$GOAL" wait_state)"
assert_err_mentions_ci "clamp/the-clamp-is-reported" "clamp"

CLAMPED="$(state_field "$GOAL" wait_deadline)"
if [ -n "$CLAMPED" ] && [ "$CLAMPED" -lt "$FAR" ] 2>/dev/null; then
	pass "clamp/the-honoured-deadline-is-nearer-than-the-declared-one"
else
	fail "clamp/the-honoured-deadline-is-nearer-than-the-declared-one" \
		"declared=$FAR honoured=[$CLAMPED]"
fi

# Boundary: a deadline of exactly now is not in the future, so it is not a wait.
GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(now_epoch)"
gate_run "$GOAL" '{"session_id":"nowdl"}' "GOAL_GATE_STALL_MAX=5"
assert_refuses "boundary/a-deadline-of-exactly-now-refuses"
case "$(state_field "$GOAL" wait_state)" in
active) fail "boundary/a-deadline-of-exactly-now-is-not-an-active-wait" "wait_state=active for a deadline of now" ;;
*) pass "boundary/a-deadline-of-exactly-now-is-not-an-active-wait" ;;
esac

# ===========================================================================
printf -- '-- 5. R7: the cumulative wait is BOUNDED across the loop --\n'
# ===========================================================================
#
# THE defect this section exists for: without an aggregate ceiling a loop that
# re-declares a fresh wait every iteration freezes stall accounting forever and
# never permits completion — satisfying both safety mechanisms and living
# forever. The ceiling is what makes the wait a delay rather than an escape.

GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"

# A tiny cumulative ceiling, already consumed: the next declaration must be
# refused as a wait and accounting must resume.
gate_run "$GOAL" '{"session_id":"cum1"}' "GOAL_GATE_STALL_MAX=5" "GOAL_GATE_WAIT_MAX_CUMULATIVE=1"
assert_refuses "cumulative/the-first-declaration-is-honoured-or-bounded"

bash "$LOOP_STATE" set "$(loop_file "$GOAL")" wait_cumulative "999999" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"cum1"}' "GOAL_GATE_STALL_MAX=5" "GOAL_GATE_WAIT_MAX_CUMULATIVE=1"

case "$(state_field "$GOAL" wait_state)" in
exhausted | rejected) pass "cumulative/an-exhausted-budget-refuses-further-waiting" ;;
*) fail "cumulative/an-exhausted-budget-refuses-further-waiting" \
	"wait_state=[$(state_field "$GOAL" wait_state)] with the cumulative budget spent" ;;
esac
assert_err_mentions "cumulative/the-exhaustion-is-reported" "wait"

# And with waiting exhausted, the loop must be able to reach a TERMINAL stall —
# proof the freeze really lifted rather than merely being relabelled. Twice the
# threshold, because the threshold itself only warns.
# Stop at the turn that PRODUCES the terminal stall, rather than assuming which
# turn that is. A fixed count of 4 asserted on whatever the 4th turn happened to
# say: once the stall lands on turn 3, turn 4 correctly stands down with
# "already reached a reported END" and the assertion read that stand-down as a
# failure to stall at all. The property under test is "waiting no longer
# prevents a terminal stall", not "it takes exactly four turns" — and the exact
# turn count moves with stall accounting, which is why this rotted. Pre-existing:
# it fails identically on a pristine git HEAD checkout.
for _ in 1 2 3 4 5 6; do
	gate_run "$GOAL" '{"session_id":"cum1"}' "GOAL_GATE_STALL_MAX=2" "GOAL_GATE_WAIT_MAX_CUMULATIVE=1"
	# A terminal end emits no decision on stdout — that IS the signal.
	case "$RUN_OUT" in
	*'"decision"'*) : ;;
	*) break ;;
	esac
done
assert_terminal "cumulative/an-exhausted-wait-can-no-longer-prevent-a-stall"

# ===========================================================================
printf -- '-- 6. A wait never permits, and LOOP_BLOCKED beats it --\n'
# ===========================================================================

# Even with every criterion met, a declared wait must not turn into a permit by
# some other route — and equally must not BLOCK a genuine completion. The
# criteria decide completion; the wait only ever suspends stall accounting.
GOAL="$(new_goal)"
write_all_met "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"
gate_run "$GOAL" '{"session_id":"metwait"}' "GOAL_GATE_STALL_MAX=5"
case "$RUN_ERR" in
*'PERMIT:'*) pass "permit/a-met-checklist-still-permits-during-a-wait" ;;
*) fail "permit/a-met-checklist-still-permits-during-a-wait" "err=[$RUN_ERR]" ;;
esac

# LOOP_BLOCKED raised during a wait wins: the wait ends and the blocker is
# reported. A blocker names a cause; a wait only defers.
GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"
# The signal is KEYED to its workstream; a bare LOOP_BLOCKED binds nobody.
printf 'the upstream credential expired\n' >"$GOAL/.goal-gate/blockwait.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blockwait"}' "GOAL_GATE_STALL_MAX=5"
assert_terminal "precedence/loop-blocked-during-a-wait-ends-the-loop"
assert_err_mentions "precedence/the-blocker-reason-survives-a-wait" "credential expired"
assert_equals "precedence/the-blocker-is-recorded-not-the-wait" "loop_blocked" "$(state_field "$GOAL" decision)"
assert_no_record "precedence/a-blocked-wait-writes-no-completion-record" "$GOAL"

# ===========================================================================
printf -- '-- 7. Non-vacuity: a gate that ignores the wait FAILS this suite --\n'
# ===========================================================================
#
# Every "still refuses" assertion above is satisfied by a gate that ignores the
# declaration entirely. So the suspension is proven by CONTRAST: with the same
# fixture and threshold, the ONLY difference being the declaration, one run
# must survive and the other must go terminal.

# Both runs go to twice the threshold, which is where the loop ENDS. The
# comparison is on whether a `decision` is still being issued: the waiting loop
# must still be held, the unwaited one must have been let go.
GOAL="$(new_goal)"
write_unmet "$GOAL"
declare_wait "$GOAL" "$(($(now_epoch) + 3600))"
for _ in 1 2 3 4; do
	gate_run "$GOAL" '{"session_id":"contrast_w"}' "GOAL_GATE_STALL_MAX=2"
done
WAITED_OUT="$RUN_OUT"

GOAL2="$(new_goal)"
write_unmet "$GOAL2"
for _ in 1 2 3 4; do
	gate_run "$GOAL2" '{"session_id":"contrast_n"}' "GOAL_GATE_STALL_MAX=2"
done
UNWAITED_OUT="$RUN_OUT"

WAITED_HELD=0
case "$WAITED_OUT" in *'"decision"'*) WAITED_HELD=1 ;; esac
UNWAITED_HELD=0
case "$UNWAITED_OUT" in *'"decision"'*) UNWAITED_HELD=1 ;; esac

if [ "$WAITED_HELD" -eq 1 ] && [ "$UNWAITED_HELD" -eq 0 ]; then
	pass "contrast/the-declaration-is-what-suspends-the-stall"
else
	fail "contrast/the-declaration-is-what-suspends-the-stall" \
		"waited_held=$WAITED_HELD unwaited_held=$UNWAITED_HELD — the wait made no difference, so this suite proves nothing"
fi

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
