#!/usr/bin/env bash
# test-skills.sh — the cancel and help companions, and the loop-state
# scaffolding they share with the starter (T3.5).
#
# The load-bearing test in here is the blocked-escape signal. `LOOP_BLOCKED` is
# the one file the gated agent can write to end its own loop; the predecessor
# DOCUMENTED it to the model and never DETECTED it, so an agent could write it
# and no human-facing surface ever said so. Detection is the fix, and a
# reason-less blocked signal must be refused rather than honoured.
#
# The other property under test is that cancelling never reads as finishing.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CANCEL="${TEST_DIR}/../cancel.sh"
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

assert_equals() {
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "expected [$2] got [$3]"
	fi
}

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

export GOAL_GATE_SKIP_REGISTRATION_CHECK=1

# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
OUTSTANDING='# Done when

- [ ] The thing works — `run.sh`
      - explanation: not built yet.
- [ ] The other thing works — `run.sh`
      - explanation: not built yet.'

# new_tree <name> — an anchor with a started loop. Prints the anchor.
#
# The starter's status is CHECKED. Every section below depends on this fixture,
# and a silently-failed build surfaced as a scatter of confusing downstream
# failures instead of one honest "the fixture could not be built" — and in the
# blocked-signal section it left no .goal-gate/ at all, so writing LOOP_BLOCKED
# into it failed silently too.
new_tree() {
	local a="$WORK_DIR/$1" g="$WORK_DIR/$1/X.goal"
	mkdir -p -- "$g"
	printf '# charter\n' >"$g/goal.md"
	printf '%s\n' "$OUTSTANDING" >"$g/ACs.md"
	if ! GOAL_GATE_ANCHOR="$a" bash "$STARTER" "$g" >/dev/null 2>&1; then
		fail "fixture/new_tree-$1" "the starter refused to build the fixture; every assertion using it is meaningless"
	fi
	printf '%s' "$a"
}

RUN_OUT=""
RUN_RC=0
run() {
	local dir="$1"
	shift
	RUN_OUT="$(cd "$dir" && bash "$CANCEL" "$@" 2>&1)"
	RUN_RC=$?
}

loop_of() {
	# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
	ls "$1"/.goal-gate/*.state 2>/dev/null | head -1
}

# --------------------------------------------------------------------------
# 1. Scaffolding — the guard and the ignore entries
# --------------------------------------------------------------------------

A="$(new_tree scaffold)"

if [ -f "$A/.goal-gate/CLAUDE.md" ]; then
	pass "scaffold/guard-written-by-the-starter"
else
	fail "scaffold/guard-written-by-the-starter" "no guard at $A/.goal-gate/CLAUDE.md"
fi
if grep -q "Do not edit" "$A/.goal-gate/CLAUDE.md" 2>/dev/null; then
	pass "scaffold/guard-says-do-not-edit"
else
	fail "scaffold/guard-says-do-not-edit" "the guard does not warn against hand-editing"
fi
# The guard must point at the honest routes out, not just forbid things.
if grep -q "LOOP_BLOCKED" "$A/.goal-gate/CLAUDE.md" 2>/dev/null &&
	grep -q "cancel" "$A/.goal-gate/CLAUDE.md" 2>/dev/null; then
	pass "scaffold/guard-names-the-honest-exits"
else
	fail "scaffold/guard-names-the-honest-exits" "the guard forbids without offering the sanctioned routes"
fi

if grep -qxF '.goal-gate/' "$A/.gitignore" 2>/dev/null; then
	pass "scaffold/ignore-entry-created"
else
	fail "scaffold/ignore-entry-created" "no ignore entry in $A/.gitignore"
fi

# Empty/Null: already contains the entry -> not duplicated.
run "$A" scaffold "$A"
COUNT="$(grep -cxF '.goal-gate/' "$A/.gitignore" 2>/dev/null)"
assert_equals "scaffold/ignore-entry-not-duplicated" "1" "$COUNT"
case "$RUN_OUT" in
*"already present"*) pass "scaffold/reports-idempotence" ;;
*) fail "scaffold/reports-idempotence" "a second scaffold did not report it was already present: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 2. Help / status — describes the CURRENT mechanism
# --------------------------------------------------------------------------

run "$A" status "$A"
assert_equals "status/active-loop-found" "0" "$RUN_RC"
for token in "workstream" "goal folder" "criteria" "iteration"; do
	case "$RUN_OUT" in
	*"$token"*) pass "status/reports-$(printf '%s' "$token" | tr ' ' '-')" ;;
	*) fail "status/reports-$(printf '%s' "$token" | tr ' ' '-')" "status omits '$token': [$RUN_OUT]" ;;
	esac
done

# A loop the gate has not yet claimed says so, rather than implying it is live.
case "$RUN_OUT" in
*UNCLAIMED*) pass "status/unclaimed-is-reported" ;;
*) fail "status/unclaimed-is-reported" "a not-yet-claimed loop is not reported as such: [$RUN_OUT]" ;;
esac

# Invalid input: no loop anywhere is REPORTED, not silently fine.
EMPTY="$WORK_DIR/no-loop"
mkdir -p -- "$EMPTY"
run "$EMPTY" status "$EMPTY"
if [ "$RUN_RC" -eq 0 ]; then
	fail "status/no-loop-is-not-success" "status reported success with no loop present"
else
	pass "status/no-loop-is-not-success"
fi

# The help document describes the mechanism as it is now.
HELP="${TEST_DIR}/../SKILL-help.md"
# Existence FIRST. The negative grep below passes on grep's exit 2, so a missing
# or empty SKILL-help.md made `help/no-predecessor-names` green for the worst
# possible reason — there being no help document at all.
if [ -s "$HELP" ]; then
	pass "help/document-exists-before-we-grep-it"
else
	fail "help/document-exists-before-we-grep-it" "no SKILL-help.md; every assertion below is vacuous"
fi
for token in "pursue-goal" "ACs.md" "evidence" "LOOP_BLOCKED"; do
	if grep -qF -- "$token" "$HELP" 2>/dev/null; then
		pass "help/describes-$(printf '%s' "$token" | tr '.' '-')"
	else
		fail "help/describes-$(printf '%s' "$token" | tr '.' '-')" "SKILL-help.md does not mention $token"
	fi
done
# The predecessor's name, and the host's built-in goal command it used to tell
# people to drive charters with. `/goal-gate-help` is this feature's own trigger
# and must not match.
# shellcheck disable=SC2016  # a literal grep pattern, not an expansion
if grep -qiE 'jam-loop|`/goal`|/goal command' "$HELP" 2>/dev/null; then
	fail "help/no-predecessor-names" "the help still names the predecessor mechanism"
else
	pass "help/no-predecessor-names"
fi

# --------------------------------------------------------------------------
# 3. Cancel — a reported END, never a completion
# --------------------------------------------------------------------------

B="$(new_tree cancelme)"
LOOP_B="$(loop_of "$B")"

run "$B" cancel "$B"
assert_equals "cancel/succeeds" "0" "$RUN_RC"
assert_equals "cancel/status-is-cancelled" "cancelled" "$(bash "$LOOP_STATE" get "$LOOP_B" status)"

case "$RUN_OUT" in
*"NOT a completion"*) pass "cancel/says-it-is-not-completion" ;;
*) fail "cancel/says-it-is-not-completion" "cancel does not distinguish itself from finishing: [$RUN_OUT]" ;;
esac

# Nothing may be left that could later read as done.
if [ -e "$B/.goal-gate/completion-record.md" ]; then
	fail "cancel/no-completion-record" "cancelling wrote a completion record"
else
	pass "cancel/no-completion-record"
fi
# The field must be ABSENT, not merely "not the string done" — the loose form
# also passed when the state file was empty or loop-state.sh errored.
if bash "$LOOP_STATE" get "$LOOP_B" acs_verdict >/dev/null 2>&1; then
	fail "cancel/verdict-not-forged" "cancelling recorded an acs_verdict: $(bash "$LOOP_STATE" get "$LOOP_B" acs_verdict)"
else
	pass "cancel/verdict-not-forged"
fi
# ...and the state file is still readable, so the check above meant something.
if [ -n "$(bash "$LOOP_STATE" get "$LOOP_B" status 2>/dev/null)" ]; then
	pass "cancel/state-file-still-readable"
else
	fail "cancel/state-file-still-readable" "the state file is unreadable; the verdict check proved nothing"
fi
assert_equals "cancel/records-what-it-was" "active" "$(bash "$LOOP_STATE" get "$LOOP_B" cancelled_from_status)"

# Invalid input: cancelling when nothing is active is REPORTED.
run "$B" cancel "$B"
if [ "$RUN_RC" -eq 0 ]; then
	fail "cancel/nothing-active-reported" "a second cancel reported success"
else
	pass "cancel/nothing-active-reported"
fi

run "$EMPTY" cancel "$EMPTY"
assert_equals "cancel/no-gate-directory-reported" "1" "$RUN_RC"
case "$RUN_OUT" in
*"nothing to cancel"*) pass "cancel/no-loop-explains-why" ;;
*) fail "cancel/no-loop-explains-why" "no explanation for an empty cancel: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 4. Boundary — a loop bound to a DIFFERENT conversation
# --------------------------------------------------------------------------

C="$(new_tree otherowner)"
LOOP_C="$(loop_of "$C")"
bash "$LOOP_STATE" set "$LOOP_C" claimed_by "some-other-conversation"

RUN_OUT="$(cd "$C" && GOAL_GATE_IDENTITY=this-conversation bash "$CANCEL" cancel "$C" 2>&1)"
RUN_RC=$?
assert_equals "binding/other-owner-refused" "3" "$RUN_RC"
assert_equals "binding/other-owner-not-cancelled" "active" "$(bash "$LOOP_STATE" get "$LOOP_C" status)"
case "$RUN_OUT" in
*some-other-conversation*) pass "binding/refusal-names-the-owner" ;;
*) fail "binding/refusal-names-the-owner" "the refusal does not name the owner: [$RUN_OUT]" ;;
esac

RUN_OUT="$(cd "$C" && GOAL_GATE_IDENTITY=this-conversation bash "$CANCEL" cancel "$C" --force 2>&1)"
RUN_RC=$?
assert_equals "binding/force-overrides" "0" "$RUN_RC"
assert_equals "binding/force-actually-cancels" "cancelled" "$(bash "$LOOP_STATE" get "$LOOP_C" status)"

# --------------------------------------------------------------------------
# 5. State transitions — active -> cancelled -> restarted
# --------------------------------------------------------------------------

D="$(new_tree restart)"
LOOP_D="$(loop_of "$D")"
assert_equals "transitions/starts-active" "active" "$(bash "$LOOP_STATE" get "$LOOP_D" status)"

run "$D" cancel "$D"
assert_equals "transitions/becomes-cancelled" "cancelled" "$(bash "$LOOP_STATE" get "$LOOP_D" status)"

# A cancelled loop is history, so the folder can be started again.
if GOAL_GATE_ANCHOR="$D" bash "$STARTER" "$D/X.goal" >/dev/null 2>&1; then
	pass "transitions/restart-allowed-after-cancel"
else
	fail "transitions/restart-allowed-after-cancel" "a cancelled loop still blocks a restart"
fi

# --------------------------------------------------------------------------
# 6. Error propagation — the blocked-escape signal is DETECTED
# --------------------------------------------------------------------------

E="$(new_tree blocked)"
printf 'the upstream API credentials were revoked; nobody here can reissue them\n' >"$E/.goal-gate/LOOP_BLOCKED"

run "$E" status "$E"
case "$RUN_OUT" in
*BLOCKED*) pass "blocked/signal-detected" ;;
*) fail "blocked/signal-detected" "the blocked signal was not detected at all: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*"credentials were revoked"*) pass "blocked/reason-reported" ;;
*) fail "blocked/reason-reported" "the written reason was not surfaced: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*"NON-COMPLETION"*) pass "blocked/not-a-completion" ;;
*) fail "blocked/not-a-completion" "a blocked loop was not distinguished from a finished one: [$RUN_OUT]" ;;
esac

# A blocked signal with NO reason is refused, not honoured.
F="$(new_tree blocked-empty)"
: >"$F/.goal-gate/LOOP_BLOCKED"
run "$F" status "$F"
case "$RUN_OUT" in
*"NO REASON"*) pass "blocked/reasonless-refused" ;;
*) fail "blocked/reasonless-refused" "a reason-less blocked signal was treated as valid: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 7. The skill documents exist and say the load-bearing thing
# --------------------------------------------------------------------------

CANCEL_DOC="${TEST_DIR}/../SKILL-cancel.md"
if [ -f "$CANCEL_DOC" ]; then
	pass "docs/cancel-present"
	if grep -qi "never a completion\|not finishing" "$CANCEL_DOC"; then
		pass "docs/cancel-states-the-distinction"
	else
		fail "docs/cancel-states-the-distinction" "SKILL-cancel.md does not say cancelling is not finishing"
	fi
else
	fail "docs/cancel-present" "no SKILL-cancel.md"
fi

if [ -f "$HELP" ]; then
	pass "docs/help-present"
else
	fail "docs/help-present" "no SKILL-help.md"
fi

# DISCOVERABILITY, not merely documentation. Skill lookup requires
# <dir>/SKILL.md; SKILL-cancel.md and SKILL-help.md are reference documents and
# neither is a discovery entry point. Without this file the two companions are
# present on disk and invocable by nobody — a regression against the
# predecessor skills they replace, which were real commands.
GATE_SKILL="${TEST_DIR}/../SKILL.md"
if [ -s "$GATE_SKILL" ]; then
	pass "docs/goal-gate-is-a-discoverable-skill"
else
	fail "docs/goal-gate-is-a-discoverable-skill" "no SKILL.md in the goal-gate directory, so cancel and help cannot be invoked at all"
fi
if head -1 "$GATE_SKILL" 2>/dev/null | grep -q '^---$' &&
	grep -qE '^name: eque2-code-goal-gate$' "$GATE_SKILL" 2>/dev/null; then
	pass "docs/goal-gate-skill-has-frontmatter"
else
	fail "docs/goal-gate-skill-has-frontmatter" "SKILL.md lacks the frontmatter discovery requires"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
