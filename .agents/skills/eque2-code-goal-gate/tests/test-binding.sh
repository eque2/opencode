#!/usr/bin/env bash
# test-binding.sh — executable conformance suite for goal-gate-stop.sh's
# CONVERSATION BINDING and CLAIM HANDSHAKE (T2.3).
#
# The property under test is that a workstream is claimed EXACTLY ONCE and never
# taken from a conversation that still holds it. That is ancestor defect D10: the
# ancestor tested whether a workstream was free and then took it, so two
# conversations ending a turn together could both observe it as free and both
# proceed. A check-then-act IS the race, so the race here is REAL — background
# subshells released against a common barrier — never simulated by calling an
# internal function twice in sequence. A simulated race cannot fail, which means
# it cannot pass either.
#
# The second property is that the fix does not create a worse problem than it
# solves: a claim held by a conversation that has died must not wedge the
# workstream forever (review finding R8, scenario S58), so a claim whose
# heartbeat has gone stale is reclaimable and the reclamation is REPORTED.
#
# And the third is the fail-closed distinction the standing constraint names:
# "no workstream present" means the gate OWNS nothing and exits silently, which
# is NOT the same as permitting a completion it was asked to gate. Both halves
# are asserted, against the same fixture shape, so the two cannot be conflated.
#
# Observables only. Nothing here inspects the gate's internals; every assertion
# reads stdout, stderr, the exit status, the on-disk claim, or a loop-state
# field through loop-state.sh — its own public reader.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# GATE override (for the non-vacuity mutation check only):
#   GOAL_GATE_MODULE=/path/to/mutant.sh bash test-binding.sh

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_MODULE:-${TEST_DIR}/../goal-gate-stop.sh}"
GATE_DIR_OF_MODULE="$(cd -- "$(dirname -- "$GATE")" && pwd -P)"
LOOP_STATE="${GATE_DIR_OF_MODULE}/loop-state.sh"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-binding.XXXXXX")"
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

assert_not_equals() {
	if [ "$2" != "$3" ]; then
		pass "$1"
	else
		fail "$1" "expected anything but [$2]"
	fi
}

assert_contains() {
	case "$3" in
	*"$2"*) pass "$1" ;;
	*) fail "$1" "expected to contain [$2], got [$3]" ;;
	esac
}

assert_not_contains() {
	case "$3" in
	*"$2"*) fail "$1" "expected NOT to contain [$2], got [$3]" ;;
	*) pass "$1" ;;
	esac
}

# ==========================================================================
# Harness
# ==========================================================================

# new_goal — a fresh `X.goal/` folder with its `.goal-gate/` inside; echoes the
# goal-folder path.
#
# Uniqueness comes from mktemp, never from a counter: a counter incremented
# inside a command substitution is discarded with the subshell, which silently
# collapsed every fixture onto one directory in an earlier suite in this project
# and made a whole family of "leaves no state file" assertions measure the
# residue of previous tests.
new_goal() {
	local d
	d="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	# Physical path: the gate resolves its gate directory with `pwd -P`, so
	# under a $TMPDIR that is itself a symlink (every macOS run) a logical path
	# here would compare unequal to the one the gate records.
	d="$(cd -- "$d" && pwd -P)"
	mkdir -p "$d/.goal-gate"
	printf '%s' "$d"
}

# anon <gate-dir> <token> — write an UNCLAIMED workstream, the way `pursue-goal`
# does: a real loop-state file named `_anon-<token>.state`, carrying the birth
# token as a field, and nothing else. It is written through loop-state.sh rather
# than by hand so the fixture is a file the gate's own reader accepts.
#
# `workstream_token` is part of the fixture because it is part of what
# `pursue-goal` writes. It is the JOIN KEY: the file is renamed at least once
# and usually twice, so the token in the NAME stops being readable after the
# first hop, and every later reader has to use the field.
anon() {
	bash "$LOOP_STATE" set "$1/_anon-$2.state" "created_by" "pursue-goal" >/dev/null 2>&1
	bash "$LOOP_STATE" set "$1/_anon-$2.state" "workstream_token" "$2" >/dev/null 2>&1
}

# --- the helpers below take a full BASE, not a token -----------------------
#
# They used to take a token and compose `_anon-<token>` themselves, which was
# fine while a workstream kept one name for life. It does not: claiming renames
# it to `_ws-<owner>` and ending renames it to `_ended-<owner>-<token>`. A
# helper that still composed `_anon-` would silently look at a path that no
# longer exists and report `<unclaimed>` for a perfectly healthy claim — an
# assertion that passes or fails for the wrong reason.
#
# So the caller names the base it means, literally: `_anon-t1` before the claim,
# `_ws-sess-happy` after it. Where the owner genuinely cannot be known in
# advance — a race — `ws_base` resolves it by the birth token instead.

# ws_base <gate-dir> <token> — the CURRENT base of the workstream born under
# <token>, whatever it has since been renamed to, or the empty string.
#
# Resolved through the `workstream_token` FIELD, never by pattern-matching the
# name: after the first rename the name no longer contains the token, which is
# the entire reason the field exists.
ws_base() {
	local p b t
	for p in "$1"/*.state; do
		[ -f "$p" ] || continue
		t="$(bash "$LOOP_STATE" get "$p" workstream_token 2>/dev/null)" || t=""
		[ "$t" = "$2" ] || continue
		b="${p##*/}"
		printf '%s' "${b%.state}"
		return 0
	done
	printf ''
}

# claim_as <gate-dir> <base> <owner> <heartbeat-age-seconds|none> [gen] — forge
# a claim held by some OTHER conversation, so the gate can be asked what it does
# with one. `none` writes no heartbeat at all.
claim_as() {
	local lock="$1/$2.claim.${5:-1}" now
	mkdir -p "$lock"
	printf '%s\n' "$3" >"$lock/owner"
	if [ "$4" != "none" ]; then
		now="$(date -u '+%s')"
		printf '%s\n' "$((now - $4))" >"$lock/heartbeat"
	fi
}

# current_gen <gate-dir> <base> — the generation in force, or 0. Computed the
# way the contract states it — numerically, so generation 10 supersedes 9 —
# rather than by reusing the gate's own helper, which would make the assertion
# agree with the implementation by construction.
current_gen() {
	local d g best=0
	for d in "$1/$2.claim."*; do
		[ -d "$d" ] || continue
		g="${d##*.claim.}"
		case "$g" in
		'' | *[!0-9]*) continue ;;
		esac
		[ "$g" -gt "$best" ] && best="$g"
	done
	printf '%s' "$best"
}

# lock_owner <gate-dir> <base> — who holds the claim IN FORCE.
lock_owner() {
	local g f
	g="$(current_gen "$1" "$2")"
	[ "$g" -gt 0 ] || {
		printf '<unclaimed>'
		return
	}
	f="$1/$2.claim.$g/owner"
	[ -f "$f" ] || {
		printf '<no owner>'
		return
	}
	head -1 -- "$f" | tr -d '\r\n'
}

# lock_count <gate-dir> — how many workstreams are claimed at all. Counts
# WORKSTREAMS, not generation directories, so a takeover does not read as a
# second claim.
lock_count() {
	find "$1" -maxdepth 1 -type d -name '*.claim.*' 2>/dev/null |
		sed 's/\.claim\.[0-9]*$//' | LC_ALL=C sort -u | grep -c . | tr -d ' '
}

# gen_dir_count <gate-dir> — raw generation directories, superseded ones
# included. Only used to assert that retirement actually happens.
gen_dir_count() {
	find "$1" -maxdepth 1 -type d -name '*.claim.*' 2>/dev/null | wc -l | tr -d ' '
}

state_count() {
	find "$1" -maxdepth 1 -type f -name '*.state' 2>/dev/null | wc -l | tr -d ' '
}

# field <state-file> <name> — a loop-state field, or the empty string when the
# field (or the file) is absent.
field() {
	bash "$LOOP_STATE" get "$1" "$2" 2>/dev/null || printf ''
}

payload() {
	printf '{"session_id":"%s"}' "$1"
}

RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0

# gate_run <goal-folder> <payload> [env assignments...]
gate_run() {
	local goal="$1" pl="$2"
	shift 2
	local outf errf
	outf="$(mktemp "$WORK_DIR/out.XXXXXX")"
	errf="$(mktemp "$WORK_DIR/err.XXXXXX")"

	printf '%s' "$pl" |
		env "GOAL_GATE_DIR=$goal/.goal-gate" "$@" bash "$GATE" >"$outf" 2>"$errf"
	RUN_STATUS=$?
	RUN_OUT="$(cat -- "$outf")"
	RUN_ERR="$(cat -- "$errf")"
	rm -f -- "$outf" "$errf"
}

assert_blocks() {
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$1" "exit $RUN_STATUS"
		return
	fi
	case "$RUN_OUT" in
	*'"decision":"block"'*) pass "$1" ;;
	*) fail "$1" "stdout was [$RUN_OUT]" ;;
	esac
}

# assert_silent <name> — the gate CLAIMED NOTHING AND HELD NOTHING.
#
# The property is the absence of a `decision`, not the absence of bytes: only a
# `decision` can hold a turn, and the gate now also emits a user-visible
# `systemMessage` on stand-downs that an operator would otherwise mistake for a
# broken gate (a live loop owned by another conversation). Insisting on zero
# bytes would pin invisibility itself as the contract.
assert_silent() {
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$1" "exit $RUN_STATUS"
		return
	fi
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$1" "stdout was [$RUN_OUT], expected no decision"
		return
		;;
	esac
	pass "$1"
}

# assert_stands_down <name> <stderr-needle> — the STRONGER form of the above,
# and the one every new case uses.
#
# `assert_silent` checks the exit status and the absence of a decision, which is
# the same "passes on an empty result" shape this changeset removed from
# test-bystander.sh: a gate that crashed before deciding also exits 0 with no
# decision on stdout, and so does a fixture that never built. The stated reason
# on stderr is what tells "the gate considered this turn and let it go" apart
# from "the gate died before it decided", so it is required rather than assumed.
#
# Shared with test-bystander.sh's assertion of the same name by construction:
# same three conditions, same order, same failure messages.
assert_stands_down() {
	local name="$1" needle="$2"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "the gate exited $RUN_STATUS; a stand-down must exit 0"
		return
	fi
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "a decision was emitted, so the turn was not let go: [$RUN_OUT]"
		return
		;;
	esac
	case "$RUN_ERR" in
	*"$needle"*) : ;;
	*)
		fail "$name" "stderr does not say why the turn was let go (wanted [$needle]): [$RUN_ERR]"
		return
		;;
	esac
	pass "$name"
}

# race <goal-folder> <n> <session-prefix> [env assignments...] — release <n>
# gate invocations against ONE gate directory as close to simultaneously as the
# operating system allows.
#
# This is a REAL race: <n> background subshells each spin on a barrier file and
# then exec the gate, so they are all inside the claim window together. Nothing
# here serialises them, and nothing simulates contention by calling the claim
# twice in sequence — a simulated race cannot fail, so it proves nothing.
#
# Sets RACE_ERRS to the directory holding each racer's stderr.
RACE_ERRS=""
race() {
	local goal="$1" n="$2" prefix="$3"
	shift 3
	local barrier i pids
	RACE_ERRS="$(mktemp -d "$WORK_DIR/race.XXXXXX")"
	barrier="$RACE_ERRS/GO"
	pids=""

	for i in $(seq 1 "$n"); do
		(
			# Spin, do not sleep-then-run: a sleep would stagger the racers by
			# whatever the scheduler happened to do, which is the opposite of
			# what this needs.
			while [ ! -e "$barrier" ]; do :; done
			printf '%s' "$(payload "${prefix}${i}")" |
				env "GOAL_GATE_DIR=$goal/.goal-gate" "$@" bash "$GATE" \
					>"$RACE_ERRS/out.$i" 2>"$RACE_ERRS/err.$i"
			printf '%s' "$?" >"$RACE_ERRS/rc.$i"
		) &
		pids="$pids $!"
	done

	# Let every racer reach the barrier before releasing it.
	sleep 0.5
	: >"$barrier"
	# shellcheck disable=SC2086  # deliberate word splitting over the pid list.
	wait $pids 2>/dev/null
}

# race_claims — how many racers announced a fresh claim.
race_claims() {
	grep -l 'claimed unclaimed workstream' "$RACE_ERRS"/err.* 2>/dev/null | wc -l | tr -d ' '
}

# race_reclaims — how many racers announced a reclamation.
race_reclaims() {
	grep -l 'RECLAIMED workstream' "$RACE_ERRS"/err.* 2>/dev/null | wc -l | tr -d ' '
}

printf '\n== T2.3 conversation binding and the claim handshake ==\n\n'

# ==========================================================================
# 0. The fixture itself is honest
# ==========================================================================
#
# Every assertion below rests on `anon` producing a workstream the gate can
# actually read. If it silently produced nothing, most of this suite would pass
# vacuously by testing the self-bind fallback over and over.

G_FX="$(new_goal)"
anon "$G_FX/.goal-gate" "fixture"
if [ -f "$G_FX/.goal-gate/_anon-fixture.state" ]; then
	pass "fixture/an-unclaimed-workstream-is-a-real-state-file"
else
	fail "fixture/an-unclaimed-workstream-is-a-real-state-file" "not created"
fi
assert_equals "fixture/an-unclaimed-workstream-carries-no-claim" \
	"0" "$(lock_count "$G_FX/.goal-gate")"

# ==========================================================================
# 1. Happy path — an unclaimed workstream is claimed, and stays claimed
# ==========================================================================

G_H="$(new_goal)"
GH="$G_H/.goal-gate"
anon "$GH" "t1"

# Everything that must survive the claim is recorded FIRST, from the file under
# its birth name, so the "unchanged" assertions below compare against values
# captured before the rename rather than against whatever the file says
# afterwards. An assertion that reads both sides out of the same file after the
# fact cannot fail.
HAPPY_BIRTH_TOKEN="$(field "$GH/_anon-t1.state" workstream_token)"
HAPPY_CREATED_BY="$(field "$GH/_anon-t1.state" created_by)"

gate_run "$G_H" "$(payload "sess-happy")"
assert_equals "happy/the-unclaimed-workstream-is-now-claimed" \
	"1" "$(lock_count "$GH")"
assert_equals "happy/the-claim-names-the-claiming-conversation" \
	"sess-happy" "$(lock_owner "$GH" "_ws-sess-happy")"
assert_equals "happy/the-workstream-records-its-owner" \
	"sess-happy" "$(field "$GH/_ws-sess-happy.state" claimed_by)"
assert_equals "happy/the-claim-is-reported-as-a-fresh-claim" \
	"claimed" "$(field "$GH/_ws-sess-happy.state" claim_event)"
assert_contains "happy/the-claim-is-announced-on-stderr" \
	"claimed unclaimed workstream" "$RUN_ERR"

# --- CLAIMING RENAMES THE WORKSTREAM TO ITS OWNER (S62) -------------------
#
# This asserted the OPPOSITE until the retirement scheme arrived, on the
# reasoning that a stable filename keeps a loop's iteration history attached to
# one name. That reasoning was answered rather than overruled: the history moves
# WITH the file (asserted below, field by field), and the name is never the key
# — the claim directory is. What the old shape could not do is make a FINISHED
# loop structurally invisible to binding, and a finished loop that still looked
# live in the adoptable pool is how an unrelated session came to be held to a
# completed goal's criteria. The name has to be able to say what the file is.
#
# So: the file MOVED, it moved to exactly one place, and nothing else is left
# behind. All three, because "renamed" and "copied" leave the same evidence at
# the destination.
if [ -f "$GH/_ws-sess-happy.state" ]; then
	pass "happy/claiming-renames-the-workstream-to-its-owner"
else
	fail "happy/claiming-renames-the-workstream-to-its-owner" \
		"no _ws-sess-happy.state; the directory holds: $(ls "$GH")"
fi
if [ -e "$GH/_anon-t1.state" ]; then
	fail "happy/the-rename-is-a-move-not-a-copy" "_anon-t1.state is still there"
else
	pass "happy/the-rename-is-a-move-not-a-copy"
fi
assert_equals "happy/the-rename-leaves-exactly-one-workstream" \
	"1" "$(state_count "$GH")"

# Every field written before the rename survives it, compared against values
# captured from the birth file above.
assert_equals "happy/the-birth-token-survives-the-rename" \
	"$HAPPY_BIRTH_TOKEN" "$(field "$GH/_ws-sess-happy.state" workstream_token)"
assert_equals "happy/the-birth-token-is-the-literal-birth-name" \
	"t1" "$(field "$GH/_ws-sess-happy.state" workstream_token)"
assert_equals "happy/fields-written-before-the-rename-survive-it" \
	"$HAPPY_CREATED_BY" "$(field "$GH/_ws-sess-happy.state" created_by)"
assert_equals "happy/the-rename-records-where-the-loop-came-from" \
	"_anon-t1" "$(field "$GH/_ws-sess-happy.state" claimed_from_name)"

# The claim generations move in LOCKSTEP with the state file. A rename that
# moved the file but left the claim behind would present a claimed loop as
# unclaimed, which is the one shape the whole handshake exists to prevent.
if [ -d "$GH/_ws-sess-happy.claim.1" ]; then
	pass "happy/the-claim-generation-moves-with-the-workstream"
else
	fail "happy/the-claim-generation-moves-with-the-workstream" \
		"no _ws-sess-happy.claim.1; the directory holds: $(ls "$GH")"
fi
if [ -e "$GH/_anon-t1.claim.1" ]; then
	fail "happy/no-claim-is-left-behind-under-the-old-name" "_anon-t1.claim.1 remains"
else
	pass "happy/no-claim-is-left-behind-under-the-old-name"
fi
assert_equals "happy/the-rename-leaves-exactly-one-claimed-workstream" \
	"1" "$(lock_count "$GH")"

# The claim is a DIRECTORY, and a numbered one. That is the observable evidence
# of the atomic primitive: `mkdir` either creates it or fails with EEXIST,
# indivisibly. A regular file written after a `[ -e ]` test would be the D10
# race, and an UNnumbered lock could not make a takeover single-winner.
assert_equals "happy/a-first-claim-is-generation-one" \
	"1" "$(current_gen "$GH" "_ws-sess-happy")"

assert_equals "happy/iteration-is-recorded-against-the-claimed-workstream" \
	"1" "$(field "$GH/_ws-sess-happy.state" iteration)"

# ...and a second turn from the SAME conversation resolves to the SAME
# workstream. This is S12's "subsequent invocations resolve to the same
# workstream": if it did not hold, the iteration counter would read 1 forever
# and a stall could never be detected.
gate_run "$G_H" "$(payload "sess-happy")"
assert_equals "happy/a-second-turn-resolves-to-the-same-workstream" \
	"existing" "$(field "$GH/_ws-sess-happy.state" claim_event)"
assert_equals "happy/a-second-turn-advances-the-same-iteration-counter" \
	"2" "$(field "$GH/_ws-sess-happy.state" iteration)"
assert_equals "happy/a-second-turn-creates-no-second-claim" \
	"1" "$(lock_count "$GH")"
assert_equals "happy/a-second-turn-creates-no-second-workstream" \
	"1" "$(state_count "$GH")"
assert_equals "happy/the-owner-is-unchanged" \
	"sess-happy" "$(lock_owner "$GH" "_ws-sess-happy")"
assert_not_contains "happy/a-re-resolution-is-not-announced-as-a-new-claim" \
	"claimed unclaimed workstream" "$RUN_ERR"

# An `existing` binding does NOT rename. The file is already named for this
# owner, so a second rename would be churn with a failure mode and no gain.
assert_equals "happy/a-second-turn-does-not-rename-again" \
	"1" "$(current_gen "$GH" "_ws-sess-happy")"

# A third turn, to pin that this is stable rather than a two-turn coincidence.
gate_run "$G_H" "$(payload "sess-happy")"
assert_equals "happy/a-third-turn-still-resolves-to-the-same-workstream" \
	"3" "$(field "$GH/_ws-sess-happy.state" iteration)"

# Binding is never a permit. Everything above happened with no acceptance
# criteria file, so the turn must still be refused.
assert_blocks "happy/binding-a-workstream-never-permits-completion"

# ==========================================================================
# 2. Concurrency — the D10 race, for real
# ==========================================================================
#
# S29: an unclaimed workstream is present and several conversations end a turn
# simultaneously; exactly ONE claim succeeds and the others are unaffected.

G_R="$(new_goal)"
GR="$G_R/.goal-gate"
anon "$GR" "race"

race "$G_R" 8 "racer-"

assert_equals "race/exactly-one-claim-exists-on-disk" \
	"1" "$(lock_count "$GR")"
assert_equals "race/exactly-one-racer-announced-a-claim" \
	"1" "$(race_claims)"
assert_equals "race/no-racer-reclaimed-a-live-claim" \
	"0" "$(race_reclaims)"

# The winner is one of the racers, and the workstream records that same
# conversation — the claim on disk and the state file cannot disagree.
#
# The winner's identity is not knowable in advance, so the base is resolved
# through the birth token rather than composed from a name. Being able to do
# that at all is the point of writing the token at birth.
RACE_BASE="$(ws_base "$GR" race)"
assert_equals "race/the-workstream-is-named-for-its-winner" \
	"_ws-" "$(printf '%s' "$RACE_BASE" | cut -c1-4)"
RACE_WINNER="$(lock_owner "$GR" "$RACE_BASE")"
case "$RACE_WINNER" in
racer-[1-8]) pass "race/the-winner-is-one-of-the-racers" ;;
*) fail "race/the-winner-is-one-of-the-racers" "owner was [$RACE_WINNER]" ;;
esac
assert_equals "race/the-renamed-workstream-names-the-winner" \
	"_ws-$RACE_WINNER" "$RACE_BASE"
assert_equals "race/the-workstream-agrees-with-the-claim" \
	"$RACE_WINNER" "$(field "$GR/$RACE_BASE.state" claimed_by)"
assert_equals "race/the-birth-token-survived-the-contended-claim" \
	"race" "$(field "$GR/$RACE_BASE.state" workstream_token)"

# "The other conversation is unaffected": every racer completed normally, exit
# 0, and none of them PERMITTED. The winner is gated on the workstream it took;
# the losers are bystanders and stand down silently.
#
# The counts are asymmetric on purpose. "At least one blocked" rather than
# "exactly one" because a loser can legitimately self-bind before the winner's
# heartbeat lands and so not yet see a live foreign owner — a timing detail, not
# a fault. What must be EXACTLY zero is output that neither blocks nor stands
# down: any other shape would be a racer vouching for a goal it does not own. A
# `systemMessage`-only object is a stand-down that explains itself — it carries
# no `decision`, so it holds nothing and claims nothing.
RACE_BAD_RC=0
RACE_BAD_OUT=0
RACE_BLOCKS=0
for i in $(seq 1 8); do
	[ "$(cat "$RACE_ERRS/rc.$i" 2>/dev/null)" = "0" ] || RACE_BAD_RC=$((RACE_BAD_RC + 1))
	case "$(cat "$RACE_ERRS/out.$i" 2>/dev/null)" in
	*'"decision":"block"'*) RACE_BLOCKS=$((RACE_BLOCKS + 1)) ;;
	"") : ;;
	*'"decision"'*) RACE_BAD_OUT=$((RACE_BAD_OUT + 1)) ;;
	*systemMessage*) : ;;
	*) RACE_BAD_OUT=$((RACE_BAD_OUT + 1)) ;;
	esac
done
assert_equals "race/every-racer-exited-0" "0" "$RACE_BAD_RC"
assert_equals "race/no-racer-emitted-anything-but-a-block-or-silence" \
	"0" "$RACE_BAD_OUT"
if [ "$RACE_BLOCKS" -ge 1 ]; then
	pass "race/the-conversation-holding-the-claim-is-gated"
else
	fail "race/the-conversation-holding-the-claim-is-gated" \
		"eight racers contended for a workstream and not one was gated on it"
fi

# The losers do NOT self-bind — a conversation not driving a loop here, with no
# goal to pursue where it stands, stands down and writes nothing (the gate is
# passive when not pursuing a goal). So the only workstream on disk is the one
# the winner claimed (S28: no two conversations share a loop file, achieved here
# by the losers holding none).
assert_equals "race/the-losers-bound-nothing-only-the-claim-remains" \
	"1" "$(state_count "$GR")"

# --- the same race over SEVERAL unclaimed workstreams --------------------
#
# Three workstreams, six racers. Pass 2 scans on after losing a race, so the
# hazard here is a conversation claiming two, or two conversations landing on
# one. Exactly three claims must exist and their owners must be distinct.

G_R3="$(new_goal)"
GR3="$G_R3/.goal-gate"
anon "$GR3" "m1"
anon "$GR3" "m2"
anon "$GR3" "m3"

race "$G_R3" 6 "multi-"

assert_equals "race/three-workstreams-yield-exactly-three-claims" \
	"3" "$(lock_count "$GR3")"
assert_equals "race/exactly-three-racers-announced-a-claim" \
	"3" "$(race_claims)"

R3_OWNERS="$(lock_owner "$GR3" "$(ws_base "$GR3" m1)")
$(lock_owner "$GR3" "$(ws_base "$GR3" m2)")
$(lock_owner "$GR3" "$(ws_base "$GR3" m3)")"
assert_equals "race/no-conversation-claimed-two-workstreams" \
	"3" "$(printf '%s\n' "$R3_OWNERS" | LC_ALL=C sort -u | wc -l | tr -d ' ')"

# Three distinct owners means three distinct `_ws-` names, so no rename
# collided and none was skipped. A collision would leave a workstream under its
# birth name, which this catches.
R3_BASES="$(ws_base "$GR3" m1)
$(ws_base "$GR3" m2)
$(ws_base "$GR3" m3)"
assert_equals "race/each-claimed-workstream-took-its-own-owners-name" \
	"3" "$(printf '%s\n' "$R3_BASES" | grep -c '^_ws-' | tr -d ' ')"

# ==========================================================================
# 3. Invalid input — several unclaimed workstreams, one DEFINED answer
# ==========================================================================
#
# The rule is stated, not incidental: ascending, LC_ALL=C, byte-wise, first
# wins.
#
# THE HARD PART IS PROVING THE FIXTURE CAN DISCRIMINATE AT ALL. Creating the
# files in some order other than the sorted one is NOT enough, and assuming it
# is cost this suite two rounds. `find` does not enumerate in creation order —
# on APFS it does not enumerate in any order the test controls — so a fixture
# built as "sorted answer created last" can still be listed answer-first, and an
# order-dependent gate then passes by pure coincidence. Measured: a mutant that
# simply reversed the enumeration passed 104 of 105 assertions, twice, under two
# different creation orders.
#
# So the fixtures do not claim to be discriminating; the suite CHECKS that they
# were. For each one it records the raw enumeration order alongside the sorted
# answer, and afterwards asserts that at least one fixture had a raw HEAD and at
# least one had a raw TAIL that differed from the answer. Those two assertions
# are what a head-taking gate and a tail-taking gate respectively cannot survive
# — and if the fixtures ever stop discriminating, the suite FAILS AND SAYS SO
# rather than passing a gate it did not actually test.

DET_TOTAL=0
DET_WRONG=0
DET_HEAD_DIFFERS=0
DET_TAIL_DIFFERS=0

for DET_NAMES in \
	"mid alpha zeta" \
	"zeta alpha mid" \
	"beta alpha zeta" \
	"gamma delta alpha beta" \
	"kilo alpha mike zulu" \
	"sierra alpha tango papa" \
	"echo foxtrot alpha bravo" \
	"yankee alpha xray whisky"; do

	G_DET="$(new_goal)"
	GDET="$G_DET/.goal-gate"
	for DET_N in $DET_NAMES; do anon "$GDET" "$DET_N"; done

	# The enumeration the gate itself will see, and the answer the stated rule
	# requires — computed here from that same list, so the expectation is
	# derived from the CONTRACT rather than copied from the implementation.
	DET_RAW="$(find "$GDET" -maxdepth 1 -type f -name '_anon-*.state' 2>/dev/null |
		sed 's|.*/||; s|\.state$||; s|^_anon-||')"
	DET_RAW_HEAD="$(printf '%s\n' "$DET_RAW" | head -1)"
	DET_RAW_TAIL="$(printf '%s\n' "$DET_RAW" | tail -1)"
	DET_WANT="$(printf '%s\n' "$DET_RAW" | LC_ALL=C sort | head -1)"

	gate_run "$G_DET" "$(payload "det-sess")"

	# WHICH ONE WAS CLAIMED, read the only way that still works once claiming
	# renames the file: the claimed workstream is `_ws-det-sess`, and the token
	# it was born under is the field it carries. Looking for a `_anon-*.claim.*`
	# directory would find nothing at all now and report every fixture wrong.
	DET_GOT="$(field "$GDET/_ws-det-sess.state" workstream_token)"

	DET_TOTAL=$((DET_TOTAL + 1))
	[ "$DET_GOT" = "$DET_WANT" ] || DET_WRONG=$((DET_WRONG + 1))
	[ "$DET_RAW_HEAD" != "$DET_WANT" ] && DET_HEAD_DIFFERS=$((DET_HEAD_DIFFERS + 1))
	[ "$DET_RAW_TAIL" != "$DET_WANT" ] && DET_TAIL_DIFFERS=$((DET_TAIL_DIFFERS + 1))
done

assert_equals "determinism/every-fixture-resolved-to-the-sorted-minimum" \
	"0" "$DET_WRONG"

if [ "$DET_HEAD_DIFFERS" -gt 0 ]; then
	pass "determinism/the-fixtures-discriminate-against-taking-the-listing-head"
else
	fail "determinism/the-fixtures-discriminate-against-taking-the-listing-head" \
		"in all $DET_TOTAL fixtures the enumeration head WAS the sorted answer, so a gate that took the head would have passed untested"
fi

if [ "$DET_TAIL_DIFFERS" -gt 0 ]; then
	pass "determinism/the-fixtures-discriminate-against-taking-the-listing-tail"
else
	fail "determinism/the-fixtures-discriminate-against-taking-the-listing-tail" \
		"in all $DET_TOTAL fixtures the enumeration tail WAS the sorted answer, so a gate that took the tail would have passed untested"
fi

# One claim per fixture, not several.
G_D1="$(new_goal)"
GD1="$G_D1/.goal-gate"
anon "$GD1" "mid"
anon "$GD1" "alpha"
anon "$GD1" "zeta"
gate_run "$G_D1" "$(payload "sess-det1")"
assert_equals "determinism/the-lexicographically-first-workstream-is-claimed" \
	"alpha" "$(field "$GD1/_ws-sess-det1.state" workstream_token)"
assert_equals "determinism/the-claim-names-the-claiming-conversation" \
	"sess-det1" "$(lock_owner "$GD1" "_ws-sess-det1")"
assert_equals "determinism/only-the-chosen-workstream-is-claimed" \
	"1" "$(lock_count "$GD1")"
# ...and the two that were NOT claimed keep their birth names, untouched.
if [ -f "$GD1/_anon-mid.state" ] && [ -f "$GD1/_anon-zeta.state" ]; then
	pass "determinism/the-unclaimed-workstreams-are-not-renamed"
else
	fail "determinism/the-unclaimed-workstreams-are-not-renamed" \
		"the directory holds: $(ls "$GD1")"
fi

# Byte-wise, NOT numeric — `_anon-1` sorts before `_anon-10` sorts before
# `_anon-2`. Pinning this stops the rule quietly becoming "sort -V" later, which
# would change which workstream an existing loop resolves to.
G_D3="$(new_goal)"
GD3="$G_D3/.goal-gate"
anon "$GD3" "10"
anon "$GD3" "2"
anon "$GD3" "1"
gate_run "$G_D3" "$(payload "sess-det3")"
assert_equals "determinism/the-order-is-byte-wise-not-numeric" \
	"1" "$(field "$GD3/_ws-sess-det3.state" workstream_token)"

# Deterministic means REPEATABLE: the same fixture shape in a fresh directory,
# several times over, may not wander.
DET_STABLE=0
for _ in 1 2 3 4; do
	G_DL="$(new_goal)"
	anon "$G_DL/.goal-gate" "beta"
	anon "$G_DL/.goal-gate" "alpha"
	anon "$G_DL/.goal-gate" "zeta"
	gate_run "$G_DL" "$(payload "sess-loop")"
	[ "$(field "$G_DL/.goal-gate/_ws-sess-loop.state" workstream_token)" = "alpha" ] ||
		DET_STABLE=$((DET_STABLE + 1))
done
assert_equals "determinism/the-answer-is-stable-across-repeated-runs" "0" "$DET_STABLE"

# --- the byte order across the TWO live prefixes --------------------------
#
# The pool holds both `_anon-*` and `_ws-*` now, so the stated order has to be
# pinned ACROSS them and not only within one. Byte-wise, `_anon-` precedes
# `_ws-` (`a` is 0x61, `w` is 0x77), so an unclaimed birth-name workstream wins
# over an unclaimed `_ws-` one whatever the rest of the name says. The fixture
# is deliberately adversarial: the `_ws-` name sorts first on any rule that
# ignores the prefix (`aaa` before `zzz`), so a gate comparing the tails alone
# would take the wrong one.
#
# An unclaimed `_ws-*` is not a contrivance: it is exactly what `cancel.sh
# adopt` leaves behind when it releases a claimed loop for the next
# conversation to pick up.
G_D5="$(new_goal)"
GD5="$G_D5/.goal-gate"
anon "$GD5" "zzz"
bash "$LOOP_STATE" set "$GD5/_ws-aaa.state" "workstream_token" "aaa" >/dev/null 2>&1
gate_run "$G_D5" "$(payload "sess-det5")"
assert_equals "determinism/anon-sorts-before-ws-byte-wise" \
	"zzz" "$(field "$GD5/_ws-sess-det5.state" workstream_token)"
if [ -f "$GD5/_ws-aaa.state" ]; then
	pass "determinism/the-unclaimed-ws-workstream-was-left-alone"
else
	fail "determinism/the-unclaimed-ws-workstream-was-left-alone" \
		"the directory holds: $(ls "$GD5")"
fi

# ...and an unclaimed `_ws-*` on its OWN is adopted, so the assertion above
# measures ORDER rather than a `_ws-` prefix being quietly ineligible. Without
# this, a gate that simply never adopted `_ws-*` would pass the case above and
# strand every loop that `adopt` ever released.
G_D6="$(new_goal)"
GD6="$G_D6/.goal-gate"
bash "$LOOP_STATE" set "$GD6/_ws-former.state" "workstream_token" "former" >/dev/null 2>&1
gate_run "$G_D6" "$(payload "sess-det6")"
assert_equals "determinism/an-unclaimed-ws-workstream-is-adoptable" \
	"former" "$(field "$GD6/_ws-sess-det6.state" workstream_token)"
assert_equals "determinism/adopting-a-ws-workstream-renames-it-to-the-new-owner" \
	"sess-det6" "$(lock_owner "$GD6" "_ws-sess-det6")"

# A workstream whose name would not survive enumeration is skipped, not used.
#
# The case that matters is a NEWLINE in the filename. Candidates are enumerated
# with `find`, which delimits on newlines, so `_anon-<LF>evil.state` arrives as
# two lines — and the leading fragment `_anon-` passes the identity allow-list
# while naming no workstream at all. A gate that stopped at the allow-list would
# claim it, then create state for a workstream that never existed, and the real
# `_anon-safe` would never be reached because `_anon-` sorts first.
#
# Both live prefixes are hostile-tested, because both are enumerated now and a
# defence applied to one of two globs is not a defence.
G_D4="$(new_goal)"
GD4="$G_D4/.goal-gate"
: >"$GD4/$(printf '_anon-\nevil').state" 2>/dev/null || true
: >"$GD4/$(printf '_ws-\nevil').state" 2>/dev/null || true
anon "$GD4" "safe"
gate_run "$G_D4" "$(payload "sess-det4")"
assert_equals "determinism/a-workstream-name-that-splits-enumeration-is-skipped" \
	"safe" "$(field "$GD4/_ws-sess-det4.state" workstream_token)"
if [ -e "$GD4/_anon-.state" ] || [ -e "$GD4/_anon-.claim.1" ]; then
	fail "determinism/no-phantom-workstream-was-invented" "state or claim created for a name fragment"
else
	pass "determinism/no-phantom-workstream-was-invented"
fi
if [ -e "$GD4/_ws-.state" ] || [ -e "$GD4/_ws-.claim.1" ]; then
	fail "determinism/no-phantom-ws-workstream-was-invented" "state or claim created for a _ws- name fragment"
else
	pass "determinism/no-phantom-ws-workstream-was-invented"
fi

# ...and no claim was composed outside the gate directory by any of it.
if [ -e "$G_D4/.claim.1" ] || [ -n "$(find "$WORK_DIR" -maxdepth 1 -name '*.claim.*' 2>/dev/null)" ]; then
	fail "determinism/no-claim-escaped-the-gate-directory" "a claim was composed outside"
else
	pass "determinism/no-claim-escaped-the-gate-directory"
fi

# ==========================================================================
# 4. Boundary — a live claim belonging to someone else is NOT stolen
# ==========================================================================
#
# S28: neither conversation claims the workstream bound to the other.

G_S="$(new_goal)"
GS="$G_S/.goal-gate"
anon "$GS" "owned"
claim_as "$GS" "_anon-owned" "sess-owner" 5   # heartbeat 5 seconds old — plainly alive

gate_run "$G_S" "$(payload "sess-thief")"
assert_equals "notheft/the-live-claim-still-belongs-to-its-owner" \
	"sess-owner" "$(lock_owner "$GS" "_anon-owned")"
# ...and the thief renamed nothing. A rename by a conversation that did not win
# the claim would be a takeover with extra steps.
if [ -f "$GS/_anon-owned.state" ] && [ ! -e "$GS/_ws-sess-thief.state" ]; then
	pass "notheft/the-arriving-conversation-renames-nothing"
else
	fail "notheft/the-arriving-conversation-renames-nothing" \
		"the directory holds: $(ls "$GS")"
fi
assert_not_contains "notheft/no-reclamation-was-announced" \
	"RECLAIMED" "$RUN_ERR"
assert_not_contains "notheft/no-fresh-claim-was-announced" \
	"claimed unclaimed workstream" "$RUN_ERR"

# The arriving conversation is not driving a loop here and no goal is being
# pursued where it stands, so it STANDS DOWN and writes nothing — no self-bound
# `<identity>.state`. Silence is the ABSENCE of a verdict, not a permit: nothing
# is claimed about the owner's goal, which is why this cannot become a bypass.
# The owner's loop is left entirely untouched.
if [ -f "$GS/sess-thief.state" ]; then
	fail "notheft/the-arriving-conversation-writes-no-state" "a bystander self-bound a state file"
else
	pass "notheft/the-arriving-conversation-writes-no-state"
fi
assert_equals "notheft/the-owners-workstream-was-not-rebound" \
	"" "$(field "$GS/_anon-owned.state" claimed_by)"
assert_equals "notheft/the-owners-iteration-counter-was-not-touched" \
	"" "$(field "$GS/_anon-owned.state" iteration)"
assert_silent "notheft/the-arriving-conversation-stands-down"
# The stand-down names the live owner it deferred to, so the operator can see
# which conversation is driving the loop.
assert_contains "notheft/the-stand-down-names-the-owner" \
	"sess-owner" "$RUN_ERR"

# An empty gate directory (a goal folder with no `_anon-*` loop and no ACs where
# it stands) has nothing to pursue and no live owner: BOTH arriving
# conversations stand down and write nothing. Two passive turns leave the
# directory as empty as they found it.
G_SB="$(new_goal)"
GSB="$G_SB/.goal-gate"
gate_run "$G_SB" "$(payload "sess-a")"
gate_run "$G_SB" "$(payload "sess-b")"
assert_equals "notheft/two-passive-turns-write-no-workstreams" \
	"0" "$(state_count "$GSB")"
assert_silent "notheft/the-second-passive-turn-is-silent"

# ==========================================================================
# 5. Boundary — a claim whose owner has gone silent is RECLAIMABLE (R8 / S58)
# ==========================================================================
#
# Without this a crashed session renders the workstream permanently unclaimable:
# nothing ever releases the lock, so the loop can never be picked up again. The
# reclamation must also be REPORTED — a takeover that looks identical to a clean
# hand-over hides the crash that caused it.

# THE FIXTURE IS BUILT BY FIRING A REAL TURN AS THE DOOMED SESSION, not by
# forging a claim on the birth name. Forging one leaves the file called
# `_anon-dead`, so the takeover is an `_anon-` to `_ws-` hop — the same shape the
# happy path already covers. What PRODUCTION always does is `_ws-` to `_ws-`:
# the first owner claimed and renamed it long before it died. That hop is the
# one where deriving the birth token from the CURRENT name goes wrong, and a
# fixture that never reaches it cannot see the error.
G_RC="$(new_goal)"
GRC="$G_RC/.goal-gate"
anon "$GRC" "dead"
gate_run "$G_RC" "$(payload "sess-dead")"
if [ -f "$GRC/_ws-sess-dead.state" ]; then
	pass "reclaim/the-fixture-reaches-the-ws-to-ws-hop"
else
	fail "reclaim/the-fixture-reaches-the-ws-to-ws-hop" \
		"the doomed session did not take a real claim; the directory holds: $(ls "$GRC")"
fi
# Now kill it: backdate the heartbeat far beyond the 900 s default window.
RC_HB="$GRC/_ws-sess-dead.claim.1/heartbeat"
printf '%s\n' "$(( $(date -u '+%s') - 5000 ))" >"$RC_HB"

gate_run "$G_RC" "$(payload "sess-rescuer")"
assert_equals "reclaim/a-stale-claim-is-taken-over" \
	"sess-rescuer" "$(lock_owner "$GRC" "_ws-sess-rescuer")"
assert_equals "reclaim/the-reclaim-is-recorded-as-such" \
	"reclaimed" "$(field "$GRC/_ws-sess-rescuer.state" claim_event)"
assert_equals "reclaim/the-displaced-owner-is-named" \
	"sess-dead" "$(field "$GRC/_ws-sess-rescuer.state" reclaimed_from)"
assert_contains "reclaim/the-reason-names-the-liveness-window" \
	"liveness window" "$(field "$GRC/_ws-sess-rescuer.state" reclaim_reason)"
assert_contains "reclaim/the-reclamation-is-announced-on-stderr" \
	"RECLAIMED workstream" "$RUN_ERR"
assert_contains "reclaim/the-announcement-names-the-displaced-owner" \
	"sess-dead" "$RUN_ERR"
assert_equals "reclaim/the-takeover-leaves-exactly-one-claim" \
	"1" "$(lock_count "$GRC")"
assert_equals "reclaim/the-reclaimed-workstream-was-not-duplicated" \
	"1" "$(state_count "$GRC")"
if [ -e "$GRC/_ws-sess-dead.state" ] || [ -e "$GRC/_ws-sess-dead.claim.1" ]; then
	fail "reclaim/the-dead-owners-name-is-not-left-behind" \
		"the directory holds: $(ls "$GRC")"
else
	pass "reclaim/the-dead-owners-name-is-not-left-behind"
fi

# THE BIRTH TOKEN SURVIVES A CHANGE OF OWNER. This is the assertion the whole
# `workstream_token` field exists for: after a `_ws-` to `_ws-` hop the current
# name carries the RESCUER's session id and no trace of the token, so anything
# deriving the token from the name here would get `sess-dead`.
assert_equals "reclaim/the-birth-token-survives-a-change-of-owner" \
	"dead" "$(field "$GRC/_ws-sess-rescuer.state" workstream_token)"

# The rescuer now owns it, so its next turn is an ordinary re-resolution rather
# than a second reclamation.
gate_run "$G_RC" "$(payload "sess-rescuer")"
assert_equals "reclaim/the-rescuer-thereafter-resolves-normally" \
	"existing" "$(field "$GRC/_ws-sess-rescuer.state" claim_event)"
assert_not_contains "reclaim/no-second-reclamation-is-announced" \
	"RECLAIMED workstream" "$RUN_ERR"

# ...and when the rescuer's run ENDS, the retired name is built from the BIRTH
# token, not from the previous owner's session id. `_ended-sess-rescuer-dead` is
# right; `_ended-sess-rescuer-sess-dead` is the exact bug this pins.
bash "$LOOP_STATE" set "$GRC/_ws-sess-rescuer.state" status cancelled >/dev/null 2>&1
gate_run "$G_RC" "$(payload "sess-rescuer")"
if [ -f "$GRC/_ended-sess-rescuer-dead.state" ]; then
	pass "reclaim/the-retired-name-uses-the-birth-token-not-the-previous-owner"
else
	fail "reclaim/the-retired-name-uses-the-birth-token-not-the-previous-owner" \
		"expected _ended-sess-rescuer-dead.state; the directory holds: $(ls "$GRC")"
fi
assert_silent "reclaim/an-ended-loop-stands-its-owner-down"

# The window is a real boundary, exercised from both sides with the SAME
# heartbeat age. If reclamation ignored the window, the first case would take
# over too.
G_W1="$(new_goal)"
anon "$G_W1/.goal-gate" "w"
claim_as "$G_W1/.goal-gate" "_anon-w" "sess-holder" 30
gate_run "$G_W1" "$(payload "sess-eager")" "GOAL_GATE_LIVENESS_WINDOW=600"
assert_equals "reclaim/inside-the-window-the-claim-stands" \
	"sess-holder" "$(lock_owner "$G_W1/.goal-gate" "_anon-w")"

G_W2="$(new_goal)"
anon "$G_W2/.goal-gate" "w"
claim_as "$G_W2/.goal-gate" "_anon-w" "sess-holder" 30
gate_run "$G_W2" "$(payload "sess-eager")" "GOAL_GATE_LIVENESS_WINDOW=10"
assert_equals "reclaim/outside-the-window-the-claim-is-reclaimed" \
	"sess-eager" "$(lock_owner "$G_W2/.goal-gate" "_ws-sess-eager")"

# A malformed window must not silently disable the rule — it falls back to the
# default, so a 30 s-old claim is still live.
G_W3="$(new_goal)"
anon "$G_W3/.goal-gate" "w"
claim_as "$G_W3/.goal-gate" "_anon-w" "sess-holder" 30
gate_run "$G_W3" "$(payload "sess-eager")" "GOAL_GATE_LIVENESS_WINDOW=not-a-number"
assert_equals "reclaim/a-malformed-window-falls-back-to-the-default" \
	"sess-holder" "$(lock_owner "$G_W3/.goal-gate" "_anon-w")"

G_W4="$(new_goal)"
anon "$G_W4/.goal-gate" "w"
claim_as "$G_W4/.goal-gate" "_anon-w" "sess-holder" 30
gate_run "$G_W4" "$(payload "sess-eager")" "GOAL_GATE_LIVENESS_WINDOW=0"
assert_equals "reclaim/a-zero-window-does-not-make-everything-reclaimable" \
	"sess-holder" "$(lock_owner "$G_W4/.goal-gate" "_anon-w")"

# A lock abandoned part-built — created, but never stamped with a heartbeat — is
# reclaimable. Treating it as live would restore the permanent wedge, since
# nothing will ever write that heartbeat now.
#
# THE FIXTURE MUST BE OLD, and that is the point of the change here. A claim is
# `mkdir` followed by two writes, so a HEALTHY claim is momentarily
# heartbeatless; judging one abandoned the instant it appears let racers take
# each other's live claims (see the reclaim race below). "Abandoned part-built"
# therefore means part-built LONGER AGO than the claim grace, which the fixture
# now says out loud by backdating the directory instead of relying on the
# heartbeat merely being absent.
age_claim() {
	touch -t 200001010000 "$1" 2>/dev/null ||
		touch -d '2000-01-01 00:00' "$1" 2>/dev/null
}

G_NH="$(new_goal)"
anon "$G_NH/.goal-gate" "hb"
claim_as "$G_NH/.goal-gate" "_anon-hb" "sess-crashed" none
age_claim "$G_NH/.goal-gate/_anon-hb.claim.1"
gate_run "$G_NH" "$(payload "sess-nh")"
assert_equals "reclaim/a-claim-with-no-heartbeat-is-reclaimable" \
	"sess-nh" "$(lock_owner "$G_NH/.goal-gate" "_ws-sess-nh")"
assert_contains "reclaim/a-heartbeatless-takeover-is-reported" \
	"no heartbeat at all" "$RUN_ERR"

# A heartbeatless claim that is BRAND NEW is left alone — it is a claim still
# being written, not an abandoned one. Without this the reclaim rule above is a
# licence to steal live claims in the gap between mkdir and the first stamp.
G_FRESH="$(new_goal)"
anon "$G_FRESH/.goal-gate" "fresh"
claim_as "$G_FRESH/.goal-gate" "_anon-fresh" "sess-writing" none
gate_run "$G_FRESH" "$(payload "sess-arriving")"
assert_equals "reclaim/a-heartbeatless-claim-still-being-written-is-not-stolen" \
	"sess-writing" "$(lock_owner "$G_FRESH/.goal-gate" "_anon-fresh")"

# ...and so is a lock with no owner recorded at all.
G_NO="$(new_goal)"
anon "$G_NO/.goal-gate" "no"
mkdir -p "$G_NO/.goal-gate/_anon-no.claim.1"
age_claim "$G_NO/.goal-gate/_anon-no.claim.1"
gate_run "$G_NO" "$(payload "sess-no")"
assert_equals "reclaim/a-claim-with-no-owner-is-reclaimable" \
	"sess-no" "$(lock_owner "$G_NO/.goal-gate" "_ws-sess-no")"

# An unreadable heartbeat is not a licence to assume the owner is alive.
G_BH="$(new_goal)"
anon "$G_BH/.goal-gate" "bh"
claim_as "$G_BH/.goal-gate" "_anon-bh" "sess-holder" 5
printf 'yesterday-ish\n' >"$G_BH/.goal-gate/_anon-bh.claim.1/heartbeat"
gate_run "$G_BH" "$(payload "sess-bh")"
assert_equals "reclaim/an-unparseable-heartbeat-is-reclaimable" \
	"sess-bh" "$(lock_owner "$G_BH/.goal-gate" "_ws-sess-bh")"

# --- the reclaim race ----------------------------------------------------
#
# The takeover has to be as single-winner as the first claim, or R8's fix
# reintroduces D10 by another door: several conversations can observe the same
# stale claim in the same instant.

G_RR="$(new_goal)"
GRR="$G_RR/.goal-gate"
anon "$GRR" "corpse"
claim_as "$GRR" "_anon-corpse" "sess-corpse" 5000

race "$G_RR" 6 "vulture-"

assert_equals "reclaim/exactly-one-racer-reclaimed-the-stale-claim" \
	"1" "$(race_reclaims)"
assert_equals "reclaim/the-takeover-race-leaves-exactly-one-claim" \
	"1" "$(lock_count "$GRR")"
RR_BASE="$(ws_base "$GRR" corpse)"
RR_OWNER="$(lock_owner "$GRR" "$RR_BASE")"
case "$RR_OWNER" in
vulture-[1-6]) pass "reclaim/the-reclaim-winner-is-one-of-the-racers" ;;
*) fail "reclaim/the-reclaim-winner-is-one-of-the-racers" "owner was [$RR_OWNER]" ;;
esac

# THE CASCADE ASSERTION. This is the one that failed on the first design, where
# each racer displaced the previous racer's fresh claim in turn and every claim
# was destroyed — six racers left ZERO claims standing. A surviving owner is
# what proves the takeover is arbitrated rather than merely serialised by luck.
assert_not_equals "reclaim/the-takeover-race-did-not-destroy-every-claim" \
	"<unclaimed>" "$RR_OWNER"
assert_equals "reclaim/the-winner-holds-the-loop-under-its-own-name" \
	"_ws-$RR_OWNER" "$RR_BASE"

# Superseded generations are retired, so a long-lived workstream does not
# accumulate one directory per takeover — and the dead owner's base is swept by
# the rename, so the whole gate directory holds exactly one generation.
#
# The GENERATION NUMBER RESETS on a rename, deliberately: generations arbitrate
# compare-and-swap on ONE name, so a name nobody has ever claimed starts at 1.
# What must not happen is two claims surviving, which the count below pins.
assert_equals "reclaim/the-superseded-generation-is-cleaned-up" \
	"1" "$(gen_dir_count "$GRR")"
assert_equals "reclaim/the-winners-claim-is-the-first-generation-of-its-new-name" \
	"1" "$(current_gen "$GRR" "$RR_BASE")"
if [ -e "$GRR/_anon-corpse.state" ] || [ -n "$(find "$GRR" -maxdepth 1 -name '_anon-corpse.claim.*' 2>/dev/null)" ]; then
	fail "reclaim/the-race-left-no-phantom-under-the-birth-name" \
		"the directory holds: $(ls "$GRR")"
else
	pass "reclaim/the-race-left-no-phantom-under-the-birth-name"
fi
assert_equals "reclaim/the-takeover-race-left-exactly-one-workstream" \
	"1" "$(state_count "$GRR")"

# ==========================================================================
# 6. Empty / null — no workstream present
# ==========================================================================
#
# THE DISTINCTION THE STANDING CONSTRAINT NAMES. "No workstream present" means
# the gate OWNS nothing, so it must exit without blocking. That is NOT the same
# as permitting a completion it was asked to gate, and the two fixtures below
# differ only in whether a gate directory exists.

BARE="$WORK_DIR/bare/deep/deeper"
mkdir -p "$BARE"
RUN_OUT=""
RUN_ERR=""
{
	RUN_OUT="$(printf '{"session_id":"nobody","cwd":"%s"}' "$BARE" |
		env -u GOAL_GATE_DIR "HOME=$WORK_DIR/bare" bash "$GATE" 2>"$WORK_DIR/bare.err")"
	RUN_STATUS=$?
}
RUN_ERR="$(cat "$WORK_DIR/bare.err")"
assert_silent "empty/no-gate-directory-means-the-gate-claims-nothing"
assert_contains "empty/the-non-claim-is-announced-on-stderr" "no claim" "$RUN_ERR"
if [ -e "$BARE/completion-record.md" ] || [ -n "$(find "$WORK_DIR/bare" -name '*.state' 2>/dev/null)" ]; then
	fail "empty/nothing-was-written-where-the-gate-governs-nothing" "state or record appeared"
else
	pass "empty/nothing-was-written-where-the-gate-governs-nothing"
fi

# The other half of the distinction: a gate directory with NO unclaimed
# workstream and no ACs where it stands is a tree where no goal is being
# pursued. The gate is PASSIVE — it STANDS DOWN silently and writes nothing,
# rather than self-binding an unrelated conversation and holding it to a goal it
# never started. Standing down is the absence of a verdict, so it can never be
# mistaken for a completion: the sharp distinction below (a met checklist where
# the gate governs nothing) still holds because a passive turn writes no
# completion record either.
G_E="$(new_goal)"
gate_run "$G_E" "$(payload "sess-empty")"
assert_silent "empty/a-gate-directory-with-no-unclaimed-workstream-stands-down"
assert_contains "empty/standing-down-is-announced-on-stderr" "no claim" "$RUN_ERR"
if [ -f "$G_E/.goal-gate/sess-empty.state" ]; then
	fail "empty/a-passive-turn-writes-no-state" "a state file was written on a passive turn"
else
	pass "empty/a-passive-turn-writes-no-state"
fi

# And the sharpest form of it: a fully met, fully evidenced checklist sitting
# where the gate governs NOTHING must still not produce a completion record.
# Owning nothing is not the same as approving everything.
NOGATE="$WORK_DIR/nogate"
mkdir -p "$NOGATE"
cat >"$NOGATE/ACs.md" <<'ACSEOF'
# Done when

- [x] The binding suite runs
  - evidence: `bash tests/test-binding.sh` reported PASS for every assertion (exit 0)
ACSEOF
RUN_OUT="$(printf '{"session_id":"nobody2","cwd":"%s"}' "$NOGATE" |
	env -u GOAL_GATE_DIR "HOME=$WORK_DIR" "GOAL_GATE_ACS=$NOGATE/ACs.md" bash "$GATE" 2>/dev/null)"
RUN_STATUS=$?
assert_silent "empty/a-met-checklist-outside-any-gate-is-still-not-claimed"
if [ -e "$NOGATE/completion-record.md" ]; then
	fail "empty/no-completion-record-is-written-outside-a-gate" "a record was written"
else
	pass "empty/no-completion-record-is-written-outside-a-gate"
fi

# ==========================================================================
# 7. Error propagation — an unreadable state directory is REPORTED
# ==========================================================================
#
# The dangerous shape is not a crash, it is silence: a state directory that
# cannot be read looks exactly like "no workstream here", and standing down
# silently ends the turn with an empty stdout, which the host reads as consent.

if [ "$(id -u)" = "0" ]; then
	pass "errprop/skipped-unreadable-directory-check-running-as-root"
else
	G_UR="$(new_goal)"
	anon "$G_UR/.goal-gate" "hidden"
	chmod 000 "$G_UR/.goal-gate"
	gate_run "$G_UR" "$(payload "sess-unreadable")"
	UR_OUT="$RUN_OUT"
	UR_ERR="$RUN_ERR"
	UR_STATUS="$RUN_STATUS"
	chmod 755 "$G_UR/.goal-gate"

	if [ "$UR_STATUS" -ne 0 ]; then
		fail "errprop/an-unreadable-state-directory-refuses" "exit $UR_STATUS"
	else
		case "$UR_OUT" in
		*'"decision":"block"'*) pass "errprop/an-unreadable-state-directory-refuses" ;;
		*) fail "errprop/an-unreadable-state-directory-refuses" "stdout was [$UR_OUT]" ;;
		esac
	fi
	assert_contains "errprop/the-refusal-names-the-state-directory" \
		"state directory" "$UR_OUT"
	assert_not_contains "errprop/an-unreadable-directory-is-not-a-non-claim" \
		"no claim" "$UR_ERR"

	# ...and the same directory, unreadable but reached by the upward walk
	# rather than by the override.
	G_UR2="$(new_goal)"
	anon "$G_UR2/.goal-gate" "hidden"
	chmod 000 "$G_UR2/.goal-gate"
	UR2_OUT="$(printf '{"session_id":"walker","cwd":"%s"}' "$G_UR2" |
		env -u GOAL_GATE_DIR "HOME=$WORK_DIR" bash "$GATE" 2>/dev/null)"
	UR2_STATUS=$?
	chmod 755 "$G_UR2/.goal-gate"
	if [ "$UR2_STATUS" -eq 0 ]; then
		case "$UR2_OUT" in
		*'"decision":"block"'*) pass "errprop/an-unreadable-directory-found-by-the-walk-refuses" ;;
		*) fail "errprop/an-unreadable-directory-found-by-the-walk-refuses" "stdout was [$UR2_OUT]" ;;
		esac
	else
		fail "errprop/an-unreadable-directory-found-by-the-walk-refuses" "exit $UR2_STATUS"
	fi

	# An unwritable state directory cannot record a claim, so it is reported too.
	G_UW="$(new_goal)"
	anon "$G_UW/.goal-gate" "ro"
	chmod 500 "$G_UW/.goal-gate"
	gate_run "$G_UW" "$(payload "sess-ro")"
	UW_OUT="$RUN_OUT"
	chmod 755 "$G_UW/.goal-gate"
	case "$UW_OUT" in
	*'"decision":"block"'*) pass "errprop/an-unwritable-state-directory-refuses" ;;
	*) fail "errprop/an-unwritable-state-directory-refuses" "stdout was [$UW_OUT]" ;;
	esac
fi

# A gate directory that genuinely does not exist is still an absence, not an
# error — the two must not collapse into each other in EITHER direction.
RUN_OUT="$(printf '{"session_id":"ghost"}' |
	env "GOAL_GATE_DIR=$WORK_DIR/no-such-gate" bash "$GATE" 2>/dev/null)"
RUN_STATUS=$?
assert_silent "errprop/a-genuinely-absent-gate-directory-is-still-a-non-claim"
if [ -e "$WORK_DIR/no-such-gate" ]; then
	fail "errprop/an-absent-gate-directory-is-not-created" "the directory was created"
else
	pass "errprop/an-absent-gate-directory-is-not-created"
fi

# ==========================================================================
# 8. Concurrency — different repositories, one user-global state directory
# ==========================================================================
#
# Two sessions working in different repositories that share a state location
# must not collide. With NO loop being pursued in the shared directory, both are
# bystanders: each stands down and writes nothing, so neither can affect the
# other — the strongest possible form of "an idle session in one repository
# cannot have anything taken over by a session in another", because there is
# nothing on disk to take.

SHARED="$(new_goal)"
REPO1="$WORK_DIR/repo1"
REPO2="$WORK_DIR/repo2"
mkdir -p "$REPO1" "$REPO2"

gate_run "$SHARED" "$(printf '{"session_id":"repo1-sess","cwd":"%s"}' "$REPO1")"
gate_run "$SHARED" "$(printf '{"session_id":"repo2-sess","cwd":"%s"}' "$REPO2")"

assert_equals "global/neither-passive-session-wrote-a-workstream" \
	"0" "$(state_count "$SHARED/.goal-gate")"
assert_equals "global/neither-repository-session-claimed-anything" \
	"0" "$(lock_count "$SHARED/.goal-gate")"
assert_silent "global/the-second-repository-session-stands-down"

# With an unclaimed workstream in the shared directory, the first session to
# arrive claims it and the second — a bystander to a live loop — does NOT take
# it and writes nothing.
SHARED2="$(new_goal)"
anon "$SHARED2/.goal-gate" "shared"
gate_run "$SHARED2" "$(printf '{"session_id":"g1","cwd":"%s"}' "$REPO1")"
gate_run "$SHARED2" "$(printf '{"session_id":"g2","cwd":"%s"}' "$REPO2")"
assert_equals "global/the-first-arrival-claimed-the-shared-workstream" \
	"g1" "$(lock_owner "$SHARED2/.goal-gate" "_ws-g1")"
assert_equals "global/the-second-arrival-did-not-take-it" \
	"1" "$(lock_count "$SHARED2/.goal-gate")"
if [ -f "$SHARED2/.goal-gate/g2.state" ]; then
	fail "global/the-second-arrival-stands-down" "a bystander self-bound a state file"
else
	pass "global/the-second-arrival-stands-down"
fi

# Two sessions racing in different repositories against one shared directory.
SHARED3="$(new_goal)"
anon "$SHARED3/.goal-gate" "contested"
race "$SHARED3" 6 "cross-"
assert_equals "global/a-cross-repository-race-still-yields-one-claim" \
	"1" "$(lock_count "$SHARED3/.goal-gate")"
assert_equals "global/a-cross-repository-race-announces-one-claim" \
	"1" "$(race_claims)"

# ==========================================================================
# 9. Discipline — binding never becomes a verdict
# ==========================================================================
#
# Every outcome above must remain incapable of ending a turn as a completion.
# The claim decides WHICH state file is used; it can never decide that the work
# is done.

G_V="$(new_goal)"
GV="$G_V/.goal-gate"
anon "$GV" "verdict"

# v1 claims the workstream and is gated on it. v2 and v3 arrive to find a live
# owner that is not them: they STAND DOWN. The invariant is NOT "everyone is
# blocked" — that was the old shape, and it conflated "not a completion" with
# "a refusal". What must hold is that no binding outcome ever PERMITS: a
# stand-down emits nothing at all, which is the absence of a verdict, not one.
gate_run "$G_V" "$(payload "v1")"
case "$RUN_OUT" in
*'"decision":"block"'*) pass "discipline/the-owner-is-gated-on-its-workstream" ;;
*) fail "discipline/the-owner-is-gated-on-its-workstream" "stdout was [$RUN_OUT]" ;;
esac

# The owner's refusal is well-formed JSON — a refusal the host cannot parse is
# a refusal that does not happen.
case "$RUN_OUT" in
'{"decision":"block","reason":"'*'"}') pass "discipline/the-refusal-is-well-formed-json" ;;
*) fail "discipline/the-refusal-is-well-formed-json" "stdout was [$RUN_OUT]" ;;
esac

DISC_SPOKE=0
for sid in v2 v3; do
	gate_run "$G_V" "$(payload "$sid")"
	# A `decision` in either direction is a verdict. An explanatory
	# systemMessage is not: it holds nothing and claims nothing.
	case "$RUN_OUT" in
	*'"decision"'*) DISC_SPOKE=$((DISC_SPOKE + 1)) ;;
	esac
done
assert_equals "discipline/a-bystander-emits-no-verdict-in-either-direction" \
	"0" "$DISC_SPOKE"

# The owner is unmoved by either of them: still the claim holder, still gated.
assert_equals "discipline/a-bystander-does-not-take-the-owners-claim" \
	"v1" "$(lock_owner "$GV" "_ws-v1")"
gate_run "$G_V" "$(payload "v1")"
case "$RUN_OUT" in
*'"decision":"block"'*) pass "discipline/the-owner-is-still-gated-afterwards" ;;
*) fail "discipline/the-owner-is-still-gated-afterwards" \
	"two bystanders standing down released the owner: [$RUN_OUT]" ;;
esac

if [ -e "$GV/completion-record.md" ]; then
	fail "discipline/binding-writes-no-completion-record" "a record was written"
else
	pass "discipline/binding-writes-no-completion-record"
fi

# A claim is never mistaken for a workstream. v1 claimed the one workstream and
# v2/v3 stood down without writing anything, so exactly ONE `*.state` file
# exists — the `.claim.N` directory v1 holds is not counted among them, however
# anything else in this project lists `*.state`.
assert_equals "discipline/a-claim-is-not-counted-as-a-workstream" \
	"1" "$(state_count "$GV")"
assert_equals "discipline/but-a-claim-was-genuinely-taken" \
	"v1" "$(lock_owner "$GV" "_ws-v1")"

# ==========================================================================
# 10. Retirement — a finished loop leaves the adoptable pool (S63/S64/S65/S66)
# ==========================================================================
#
# The name is what makes a terminal loop STRUCTURALLY unavailable to binding,
# rather than available-but-filtered by a status read every pass has to
# remember to perform. The pass that forgot is how an unrelated session came to
# be held to a completed goal's criteria.

# --- two finished runs by one identity, in one gate directory -------------
#
# THE COLLISION THAT WOULD PUT A FINISHED LOOP BACK IN THE POOL. Both runs are
# owned by `sess-twice`, so both retire to `_ended-sess-twice-<token>`, and only
# the BIRTH TOKEN keeps those two names apart. Derive the token from the current
# base instead and both runs retire to the same name; the second rename is
# skipped as a collision, and the second finished loop is left sitting in the
# adoptable pool — exactly the state this whole change exists to prevent.
G_TW="$(new_goal)"
GTW="$G_TW/.goal-gate"
anon "$GTW" "run1"
gate_run "$G_TW" "$(payload "sess-twice")"
bash "$LOOP_STATE" set "$GTW/_ws-sess-twice.state" status cancelled >/dev/null 2>&1
gate_run "$G_TW" "$(payload "sess-twice")"
anon "$GTW" "run2"
gate_run "$G_TW" "$(payload "sess-twice")"
bash "$LOOP_STATE" set "$GTW/_ws-sess-twice.state" status stalled >/dev/null 2>&1
gate_run "$G_TW" "$(payload "sess-twice")"

if [ -f "$GTW/_ended-sess-twice-run1.state" ] && [ -f "$GTW/_ended-sess-twice-run2.state" ]; then
	pass "retire/two-finished-runs-by-one-identity-retire-to-distinct-names"
else
	fail "retire/two-finished-runs-by-one-identity-retire-to-distinct-names" \
		"the gate directory holds: $(ls "$GTW")"
fi
# Neither is left in the pool. `gg_adoptable_workstreams` globs `_anon-*` and
# `_ws-*`, so this counts what a third conversation could still walk into.
TW_POOL="$(find "$GTW" -maxdepth 1 -type f \( -name '_anon-*.state' -o -name '_ws-*.state' \) 2>/dev/null | wc -l | tr -d ' ')"
assert_equals "retire/neither-finished-run-is-left-in-the-adoptable-pool" "0" "$TW_POOL"
assert_equals "retire/the-first-run-keeps-its-own-ending" \
	"cancelled" "$(field "$GTW/_ended-sess-twice-run1.state" status)"
assert_equals "retire/the-second-run-keeps-its-own-ending" \
	"stalled" "$(field "$GTW/_ended-sess-twice-run2.state" status)"

# ==========================================================================
# 10a. Retirement, asserted on EVERY ending — and on what the operator reads
# ==========================================================================
#
# WHY THIS SECTION EXISTS, STATED PLAINLY. Six terminal paths retire the
# workstream, and until now only two of them were pinned: the permit path and
# the already-ended branch cancel.sh writes. Deleting the `gg_retire_workstream`
# call from the LOOP_BLOCKED path left every suite in this project GREEN. The
# endings reached through a stall, the recursion bound, LOOP_BLOCKED and
# LOOP_PARTIAL are asserted here (the recursion bound in test-payload.sh §8,
# where its fixture already lives).
#
# TWO RULES THESE CASES FOLLOW, both deliberate:
#
#   * The retired name is compared against a LITERAL built from the birth token
#     captured off the `_anon-*` file BEFORE the first turn — never against a
#     value read back out of the file under test, and never resolved through a
#     token helper. A name-agnostic lookup passes whatever the gate happens to
#     have named the file, which is the property under test.
#
#   * The OPERATOR-FACING message is asserted too. Six terminal paths read the
#     goal label into a local BEFORE retiring, because gg_loop_label reads the
#     loop file and the rename vacates that path. Move any one of those reads
#     after its rename and the label silently falls back to the BASENAME — the
#     operator is handed `_ws-<session-id>` in place of the goal they were
#     working on, which is the defect the changelog records as fixed and the
#     spec forbids outright ("do not leak the session identity into
#     operator-facing prose"). Nothing caught it.

# seeded_goal <goal-folder> <token> — an unclaimed loop file carrying the two
# fields pursue-goal writes and gg_loop_label depends on. `anon` deliberately
# writes neither, because the binding cases above have no goal to name; a case
# asserting what the OPERATOR reads must have one, or the label falls back to
# the basename for the fixture's own reasons and proves nothing.
seeded_goal() {
	local g="$1" tok="$2" gd="$1/.goal-gate"
	bash "$LOOP_STATE" set "$gd/_anon-$tok.state" "created_by" "pursue-goal" >/dev/null 2>&1
	bash "$LOOP_STATE" set "$gd/_anon-$tok.state" "workstream_token" "$tok" >/dev/null 2>&1
	bash "$LOOP_STATE" set "$gd/_anon-$tok.state" "goal_folder" "$g" >/dev/null 2>&1
	bash "$LOOP_STATE" set "$gd/_anon-$tok.state" "acs_path" "$g/ACs.md" >/dev/null 2>&1
}

# birth_token <gate-dir> — the token in the `_anon-*` name, read BEFORE the
# first turn. After the first turn the name no longer carries it.
birth_token() {
	local p b
	for p in "$1"/_anon-*.state; do
		[ -f "$p" ] || continue
		b="${p##*/}"
		b="${b%.state}"
		printf '%s' "${b#_anon-}"
		return 0
	done
	printf '<no-anon-file>'
}

# assert_retired <name> <gate-dir> <identity> <birth-token> — the two halves of
# retirement: the file is at its retired name, and NOTHING is left in the pool.
assert_retired() {
	local name="$1" gd="$2" id="$3" tok="$4" pool
	if [ ! -f "$gd/_ended-$id-$tok.state" ]; then
		fail "$name" "expected _ended-$id-$tok.state; the directory holds: $(printf '%s ' "$gd"/*)"
		return
	fi
	pool="$(find "$gd" -maxdepth 1 -type f \( -name '_anon-*.state' -o -name '_ws-*.state' \) 2>/dev/null | wc -l | tr -d ' ')"
	if [ "$pool" != "0" ]; then
		fail "$name" "$pool state file(s) left in the adoptable pool: $(printf '%s ' "$gd"/*)"
		return
	fi
	pass "$name"
}

# assert_operator_label <name> <goal-folder> <session-id> — what a person reads.
#
# The user-visible channel is the `systemMessage` on STDOUT; stderr carries the
# machine trail, which names the workstream on purpose. So this reads RUN_OUT
# only: it must name the goal folder, and must carry neither the `_ws-` prefix
# nor the session id.
assert_operator_label() {
	local name="$1" folder="$2" sid="$3"
	case "$RUN_OUT" in
	*systemMessage*) : ;;
	*)
		fail "$name" "no operator message was emitted at all: [$RUN_OUT]"
		return
		;;
	esac
	case "$RUN_OUT" in
	*"$folder"*) : ;;
	*)
		fail "$name" "the operator message does not name the goal folder [$folder]: [$RUN_OUT]"
		return
		;;
	esac
	case "$RUN_OUT" in
	*_ws-*)
		fail "$name" "the operator message leaks a workstream name: [$RUN_OUT]"
		return
		;;
	esac
	case "$RUN_OUT" in
	*"$sid"*)
		fail "$name" "the operator message leaks the session id [$sid]: [$RUN_OUT]"
		return
		;;
	esac
	pass "$name"
}

# --- ending 1: LOOP_BLOCKED ------------------------------------------------
G_TB="$(new_goal)"
GTB="$G_TB/.goal-gate"
cat >"$G_TB/ACs.md" <<'ACSEOF'
# Done when

- [ ] **CRITICAL** The marker file exists — `artifact.txt`
  - explanation: it has not been created yet
ACSEOF
seeded_goal "$G_TB" "tb"
TB_TOKEN="$(birth_token "$GTB")"
assert_equals "retire/the-blocked-fixture-is-born-unclaimed" "tb" "$TB_TOKEN"
gate_run "$G_TB" "$(payload "sess-tb")"
assert_blocks "retire/the-blocked-fixture-is-governed-on-its-first-turn"
printf 'the vendor has not shipped the credentials\n' >"$GTB/_ws-sess-tb.LOOP_BLOCKED"
gate_run "$G_TB" "$(payload "sess-tb")"
assert_contains "retire/the-LOOP_BLOCKED-ending-is-announced" \
	"LOOP_BLOCKED" "$RUN_ERR"
assert_retired "retire/a-LOOP_BLOCKED-ending-retires-the-workstream" \
	"$GTB" "sess-tb" "$TB_TOKEN"
assert_operator_label "retire/the-LOOP_BLOCKED-message-names-the-goal-not-the-session" \
	"$G_TB" "sess-tb"

# --- ending 2: LOOP_PARTIAL ------------------------------------------------
G_TP="$(new_goal)"
GTP="$G_TP/.goal-gate"
cat >"$G_TP/ACs.md" <<'ACSEOF'
# Done when

- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] **CRITICAL** The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials this run does not have and cannot mint.
ACSEOF
seeded_goal "$G_TP" "tp"
TP_TOKEN="$(birth_token "$GTP")"
assert_equals "retire/the-partial-fixture-is-born-unclaimed" "tp" "$TP_TOKEN"
gate_run "$G_TP" "$(payload "sess-tp")"
assert_contains "retire/the-LOOP_PARTIAL-ending-is-announced" \
	"LOOP_PARTIAL" "$RUN_ERR"
assert_retired "retire/a-LOOP_PARTIAL-ending-retires-the-workstream" \
	"$GTP" "sess-tp" "$TP_TOKEN"
assert_operator_label "retire/the-LOOP_PARTIAL-message-names-the-goal-not-the-session" \
	"$G_TP" "sess-tp"

# --- ending 3: the stall ---------------------------------------------------
#
# Threshold 2, so the loop warns at 2 and ENDS at twice that. Every other stall
# case in this project runs against a SELF-BOUND loop, which is deliberately
# never renamed — so retirement on this path has never been observed.
G_TS="$(new_goal)"
GTS="$G_TS/.goal-gate"
cat >"$G_TS/ACs.md" <<'ACSEOF'
# Done when

- [ ] **CRITICAL** The marker file exists — `artifact.txt`
  - explanation: it has not been created yet
ACSEOF
seeded_goal "$G_TS" "ts"
TS_TOKEN="$(birth_token "$GTS")"
assert_equals "retire/the-stall-fixture-is-born-unclaimed" "ts" "$TS_TOKEN"
for _ in 1 2 3 4; do
	gate_run "$G_TS" "$(payload "sess-ts")" "GOAL_GATE_STALL_MAX=2"
done
assert_contains "retire/the-stall-ending-is-announced" "STALLED" "$RUN_ERR"
assert_retired "retire/a-stall-ending-retires-the-workstream" \
	"$GTS" "sess-ts" "$TS_TOKEN"
assert_operator_label "retire/the-stall-message-names-the-goal-not-the-session" \
	"$G_TS" "sess-ts"

# --- the permit, for the operator message only -----------------------------
#
# Retirement on this path is pinned in test-bystander.sh. What is asserted here
# is the half nothing else covers: the permit is the message an operator is most
# likely to read, and it is emitted AFTER the rename.
G_TC="$(new_goal)"
GTC="$G_TC/.goal-gate"
cat >"$G_TC/ACs.md" <<'ACSEOF'
# Done when

- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [x] The installer is idempotent — `scripts/install.sh`
      - evidence: `bash tests/test-install.sh` reported 40/40 PASS (exit 0)
ACSEOF
seeded_goal "$G_TC" "tc"
TC_TOKEN="$(birth_token "$GTC")"
gate_run "$G_TC" "$(payload "sess-tc")"
assert_contains "retire/the-permit-is-announced" "PERMIT:" "$RUN_ERR"
assert_retired "retire/a-permit-retires-the-workstream" \
	"$GTC" "sess-tc" "$TC_TOKEN"
assert_operator_label "retire/the-permit-message-names-the-goal-not-the-session" \
	"$G_TC" "sess-tc"

# --- the three namespace prefixes are RESERVED as identities ---------------
#
# THE NAMESPACES HAVE TO BE DISJOINT, AND THIS IS WHAT MAKES THEM SO. A
# self-bound loop is `<identity>.state` with no prefix, which is exactly what
# keeps it out of every resolution pass. An identity of `_anon-x` names that file
# `_anon-x.state` — indistinguishable from an UNCLAIMED workstream — so the
# conversation's own private loop would sit in the adoptable pool for anyone to
# claim. `_ws-` and `_ended-` collide with the claimed and retired namespaces the
# same way. The allow-list cannot express this (`_` is a perfectly good filename
# character and these are perfectly good FILE names), so it is a separate test on
# the identity, and it refuses before a path exists.
for RESERVED in "_anon-x" "_ws-x" "_ended-x"; do
	G_RS="$(new_goal)"
	GRS="$G_RS/.goal-gate"
	gate_run "$G_RS" "$(payload "$RESERVED")"
	assert_blocks "reserved/a-session-id-of-$RESERVED-is-refused"
	assert_contains "reserved/the-refusal-says-why-for-$RESERVED" \
		"reserved workstream namespace prefix" "$RUN_OUT"
	assert_equals "reserved/no-file-is-written-for-$RESERVED" \
		"0" "$(state_count "$GRS")"
done

# --- a stranger whose identity is a DASH-PREFIX of the owner's (S65) ------
#
# `_ended-sess-*` also matches `_ended-sess-happy-t1.state`, because identities
# contain dashes. A glob therefore cannot decide ownership, and the prefilter
# must be backed by an exact `binding_identity` test. `sess` below is a
# different conversation whose name is a prefix of `sess-owner`'s.
G_PX="$(new_goal)"
GPX="$G_PX/.goal-gate"
anon "$GPX" "px"
gate_run "$G_PX" "$(payload "sess-owner")"
bash "$LOOP_STATE" set "$GPX/_ws-sess-owner.state" status cancelled >/dev/null 2>&1
gate_run "$G_PX" "$(payload "sess-owner")"
if [ -f "$GPX/_ended-sess-owner-px.state" ]; then
	pass "retire/the-prefix-fixture-has-a-retired-loop"
else
	fail "retire/the-prefix-fixture-has-a-retired-loop" "the directory holds: $(ls "$GPX")"
fi
gate_run "$G_PX" "$(payload "sess")"
assert_stands_down "retire/a-dash-prefix-stranger-does-not-bind-the-owners-retired-loop" \
	"no goal is being pursued in this tree"
if [ -e "$GPX/sess.state" ]; then
	fail "retire/a-dash-prefix-stranger-writes-nothing" "the stranger self-bound a state file"
else
	pass "retire/a-dash-prefix-stranger-writes-nothing"
fi
assert_equals "retire/the-retired-loop-is-untouched-by-the-prefix-stranger" \
	"sess-owner" "$(field "$GPX/_ended-sess-owner-px.state" binding_identity)"

# --- a retired loop whose claim is MISSING or UNREADABLE ------------------
#
# Ownership fails CLOSED. A retired loop with no claim at all is decided by
# `binding_identity` alone — so the owner still gets it back. A retired loop
# whose claim exists but cannot be read is SKIPPED, because "the claim says
# somebody else" and "the claim cannot be read" must not collapse into "the
# claim says me".
G_NC="$(new_goal)"
GNC="$G_NC/.goal-gate"
anon "$GNC" "nc"
gate_run "$G_NC" "$(payload "sess-nc")"
bash "$LOOP_STATE" set "$GNC/_ws-sess-nc.state" status cancelled >/dev/null 2>&1
gate_run "$G_NC" "$(payload "sess-nc")"
rm -rf -- "$GNC/_ended-sess-nc-nc.claim.1"
gate_run "$G_NC" "$(payload "sess-nc")"
assert_stands_down "retire/a-retired-loop-with-no-claim-still-stands-its-owner-down" \
	"already reached a reported END"
assert_contains "retire/the-owner-still-reaches-its-own-claimless-retired-loop" \
	"already reached a reported END" "$RUN_ERR"
if [ -e "$GNC/sess-nc.state" ]; then
	fail "retire/the-owner-does-not-self-bind-past-its-retired-loop" \
		"a second, self-bound state file appeared"
else
	pass "retire/the-owner-does-not-self-bind-past-its-retired-loop"
fi

if [ "$(id -u)" = "0" ]; then
	pass "retire/skipped-unreadable-claim-check-running-as-root"
else
	G_UC="$(new_goal)"
	GUC="$G_UC/.goal-gate"
	anon "$GUC" "uc"
	gate_run "$G_UC" "$(payload "sess-uc")"
	bash "$LOOP_STATE" set "$GUC/_ws-sess-uc.state" status cancelled >/dev/null 2>&1
	gate_run "$G_UC" "$(payload "sess-uc")"
	chmod 000 "$GUC/_ended-sess-uc-uc.claim.1/owner"
	gate_run "$G_UC" "$(payload "sess-uc")"
	UC_ERR="$RUN_ERR"
	chmod 644 "$GUC/_ended-sess-uc-uc.claim.1/owner" 2>/dev/null || true
	assert_stands_down "retire/an-unreadable-claim-on-a-retired-loop-is-not-an-ownership-claim" \
		"no goal is being pursued in this tree"
	assert_not_contains "retire/an-unreadable-claim-does-not-default-to-the-caller" \
		"already reached a reported END" "$UC_ERR"
fi

# --- the collision skip (S66) ---------------------------------------------
#
# Two workstreams in one gate directory driven by the SAME identity — which is
# what a Codex-shaped payload with no session_id produces, since the derived key
# is per gate DIRECTORY — target the same `_ws-` name. The second rename is
# skipped, and the loop simply keeps the name it had. The name was never
# load-bearing, so the turn is still governed: that is the assertion that
# matters, not the name.
G_CL="$(new_goal)"
GCL="$G_CL/.goal-gate"
anon "$GCL" "c1"
anon "$GCL" "c2"
gate_run "$G_CL" "$(payload "sess-coll")"      # claims c1, renames to _ws-sess-coll
# Free c1's claim so the next turn's pass 2 reaches c2 while `_ws-sess-coll` is
# still occupied — the shape a collision actually takes.
rm -rf -- "$GCL/_ws-sess-coll.claim."*
gate_run "$G_CL" "$(payload "sess-coll")"
assert_blocks "collision/the-turn-is-still-governed"
# THE EXPECTED OUTCOME, NAMED. This used to read `[ -f _anon-c2.state ] || [ -f
# _ws-sess-coll.state ]`, and both of those files exist in EVERY reachable
# outcome — including one where the rename went ahead and clobbered a
# workstream, which is what the case exists to forbid. So it is stated
# positively: pass 2 reaches `_anon-c2` (it sorts before `_ws-sess-coll` under
# LC_ALL=C), claims it, finds the target name occupied, and leaves it exactly
# where it was, claimed by its new owner.
if [ -f "$GCL/_anon-c2.state" ]; then
	pass "collision/the-claimed-loop-keeps-the-name-it-already-had"
else
	fail "collision/the-claimed-loop-keeps-the-name-it-already-had" \
		"the directory holds: $(ls "$GCL")"
fi
assert_equals "collision/the-skipped-rename-still-left-the-claim-in-place" \
	"sess-coll" "$(lock_owner "$GCL" "_anon-c2")"
assert_equals "collision/the-occupied-name-was-not-overwritten" \
	"sess-coll" "$(field "$GCL/_ws-sess-coll.state" binding_identity)"
assert_equals "collision/no-workstream-was-lost-to-the-skipped-rename" \
	"2" "$(state_count "$GCL")"
assert_contains "collision/the-skip-is-reported-on-stderr" \
	"already taken in this gate directory" "$RUN_ERR"

# --- the generation increment, on a fixture where the rename is SKIPPED ---
#
# THE COMPARE-AND-SWAP IS THE WHOLE RECLAIM MECHANISM: a conversation that read
# generation <n> takes over by creating <n+1>, so of every conversation that saw
# <n> exactly one wins. It used to be pinned by asserting the generation in force
# was 2 after a takeover — but a takeover now RENAMES the workstream, and the new
# name's generations start again at 1, so that assertion was re-pinned to 1 and
# stopped saying anything about the increment.
#
# A SKIPPED rename is where the increment is still observable: the loop keeps its
# name, so it keeps its generation history, and 1 -> 2 is exactly what a takeover
# must produce. A regression that stopped incrementing — reusing the generation
# it judged dead, say — is caught here and nowhere else.
#
# The fixture: `_ws-sess-r` is occupied by a LIVE stranger's loop, so the rename
# target exists; `_anon-rc` carries a claim whose heartbeat is long dead. Pass 3
# reaches `_anon-rc` first (it sorts first under LC_ALL=C), reclaims it at
# generation 2, and cannot rename it because `_ws-sess-r` is taken.
G_RG="$(new_goal)"
GRG="$G_RG/.goal-gate"
anon "$GRG" "rc"
claim_as "$GRG" "_anon-rc" "dead-owner" 100000
bash "$LOOP_STATE" set "$GRG/_ws-sess-r.state" "created_by" "pursue-goal" >/dev/null 2>&1
bash "$LOOP_STATE" set "$GRG/_ws-sess-r.state" "workstream_token" "occupier" >/dev/null 2>&1
claim_as "$GRG" "_ws-sess-r" "someone-else" 0
gate_run "$G_RG" "$(payload "sess-r")"
assert_blocks "reclaim-gen/the-turn-is-still-governed"
assert_equals "reclaim-gen/exactly-one-generation-superseded-the-dead-one" \
	"2" "$(current_gen "$GRG" "_anon-rc")"
assert_equals "reclaim-gen/the-new-generation-names-the-rescuer" \
	"sess-r" "$(lock_owner "$GRG" "_anon-rc")"
assert_equals "reclaim-gen/the-rename-was-skipped-so-the-name-is-unchanged" \
	"2" "$(state_count "$GRG")"
if [ -f "$GRG/_anon-rc.state" ]; then
	pass "reclaim-gen/the-reclaimed-loop-kept-its-own-name"
else
	fail "reclaim-gen/the-reclaimed-loop-kept-its-own-name" "the directory holds: $(ls "$GRG")"
fi

# --- a legacy in-flight loop needs no migration step ----------------------
#
# The I/O matrix row for an upgrade. A `_anon-*` loop written by a prior release
# — no `workstream_token` field, because that release did not write one — is
# claimed and renamed by the first turn under this one, with nothing to run and
# nothing to convert. The birth-name fallback in gg_birth_token is what carries
# it, and it is safe precisely because `_anon-<token>` IS the token by
# construction.
G_LG="$(new_goal)"
GLG="$G_LG/.goal-gate"
bash "$LOOP_STATE" set "$GLG/_anon-legacy.state" "created_by" "pursue-goal" >/dev/null 2>&1
bash "$LOOP_STATE" set "$GLG/_anon-legacy.state" "iteration" "7" >/dev/null 2>&1
assert_equals "legacy/the-fixture-carries-no-birth-token" \
	"" "$(field "$GLG/_anon-legacy.state" workstream_token)"
gate_run "$G_LG" "$(payload "sess-legacy")"
if [ -f "$GLG/_ws-sess-legacy.state" ]; then
	pass "legacy/an-in-flight-loop-from-a-prior-release-is-claimed-and-renamed"
else
	fail "legacy/an-in-flight-loop-from-a-prior-release-is-claimed-and-renamed" \
		"the directory holds: $(ls "$GLG")"
fi
assert_equals "legacy/its-iteration-history-carries-over" \
	"8" "$(field "$GLG/_ws-sess-legacy.state" iteration)"
assert_blocks "legacy/the-migrated-loop-is-governed-normally"
# The birth token is BACKFILLED at that one hop, from the birth name, which is
# the last instant the name still carries it. Without this a legacy loop could
# never retire by name for the rest of its life, and "no migration step" would
# only be true of the first turn.
assert_equals "legacy/the-birth-token-is-backfilled-from-the-birth-name" \
	"legacy" "$(field "$GLG/_ws-sess-legacy.state" workstream_token)"
# ...and it still retires under a name built from its birth token, recovered
# from the birth NAME because the field was never written.
bash "$LOOP_STATE" set "$GLG/_ws-sess-legacy.state" status cancelled >/dev/null 2>&1
gate_run "$G_LG" "$(payload "sess-legacy")"
if [ -f "$GLG/_ended-sess-legacy-legacy.state" ]; then
	pass "legacy/a-loop-with-no-recorded-token-still-retires-by-its-birth-name"
else
	fail "legacy/a-loop-with-no-recorded-token-still-retires-by-its-birth-name" \
		"the directory holds: $(ls "$GLG")"
fi

# --- the ghost: a claim with no state file beside it ----------------------
#
# The intermediate state a rename passes through, staged DIRECTLY rather than
# hoped for out of an eight-way race. Between creating the new name's claim and
# moving the state file, the new base has a claim and no file; immediately after
# the move, the old base has a claim and no file. Both must be inert — a
# candidate is only real when its state file exists — or a conversation could
# claim a name with nothing behind it and then have the gate CREATE the file,
# conjuring a workstream out of a leftover directory.
#
# The race below can hit this window, but only sometimes, and a test that only
# sometimes exercises its subject is not a test of it.
G_GH="$(new_goal)"
GGH="$G_GH/.goal-gate"
mkdir -p "$GGH/_ws-ghost.claim.1"
printf 'sess-vanished\n' >"$GGH/_ws-ghost.claim.1/owner"
printf '%s\n' "$(date -u '+%s')" >"$GGH/_ws-ghost.claim.1/heartbeat"
anon "$GGH" "real"
gate_run "$G_GH" "$(payload "sess-ghost")"
assert_equals "ghost/a-claim-with-no-state-file-is-never-a-candidate" \
	"real" "$(field "$GGH/_ws-sess-ghost.state" workstream_token)"
if [ -e "$GGH/_ws-ghost.state" ]; then
	fail "ghost/no-state-file-is-invented-for-a-ghost-claim" "_ws-ghost.state was created"
else
	pass "ghost/no-state-file-is-invented-for-a-ghost-claim"
fi
assert_equals "ghost/the-ghost-adds-no-workstream" "1" "$(state_count "$GGH")"

# ...and a ghost is not mistaken for a live foreign owner either. Before the
# existence filter, a stray claim directory made every arriving conversation
# defer to a conversation that held nothing.
G_GH2="$(new_goal)"
GGH2="$G_GH2/.goal-gate"
mkdir -p "$GGH2/_ws-ghost.claim.1"
printf 'sess-vanished\n' >"$GGH2/_ws-ghost.claim.1/owner"
printf '%s\n' "$(date -u '+%s')" >"$GGH2/_ws-ghost.claim.1/heartbeat"
gate_run "$G_GH2" "$(payload "sess-arrives")"
assert_silent "ghost/a-lone-ghost-claim-is-not-a-loop-in-operation"
assert_not_contains "ghost/no-conversation-is-told-to-defer-to-a-ghost" \
	"owned by conversation sess-vanished" "$RUN_ERR"

printf '\n== %s passed, %s failed ==\n\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
