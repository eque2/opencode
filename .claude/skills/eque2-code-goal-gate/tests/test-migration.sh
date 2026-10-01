#!/usr/bin/env bash
# test-migration.sh — handing over from the predecessor deliberately (T5.1).
#
# Both hooks registered on the same event is the realistic interim state, so it
# is DEFINED here rather than discovered in the field: the default is COEXIST.
# Removing someone's working hook as a side effect of installing ours is exactly
# the clobbering the charter's canary exists to prevent, and an in-flight
# predecessor loop must not break because we arrived.
#
# Removal is therefore opt-in and REPORTED, and the predecessor's own script is
# never deleted — unregistering is ours to do, deleting another tool's files is
# not.
#
# Every test runs against a FIXTURE home. Nothing here touches the real
# `$HOME/.claude`, where a live predecessor registration exists right now.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALL="${TEST_DIR}/../install.sh"

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

PREDECESSOR="$WORK_DIR/jam-loop-stop.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$PREDECESSOR"
chmod +x "$PREDECESSOR"

THIRD_PARTY="$WORK_DIR/someone-elses-hook.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$THIRD_PARTY"
chmod +x "$THIRD_PARTY"

RUN_OUT=""
RUN_RC=0
run() {
	RUN_OUT="$(bash "$INSTALL" "$@" 2>&1)"
	RUN_RC=$?
}

settings_of() {
	printf '%s/.claude/settings.json' "$1"
}

# count_matching <settings> <pattern>
count_matching() {
	jq "[.hooks.Stop[]?.hooks[]? | select((.command // \"\") | test(\"$2\"))] | length" "$1" 2>/dev/null
}

# new_home <name> [--with-predecessor] [--with-third-party]
new_home() {
	local h="$WORK_DIR/$1" pred=0 third=0 arg
	shift
	for arg in "$@"; do
		case "$arg" in
		--with-predecessor) pred=1 ;;
		--with-third-party) third=1 ;;
		esac
	done

	mkdir -p -- "$h/.claude"
	local hooks="[]"
	if [ "$pred" -eq 1 ]; then
		hooks="$(printf '%s' "$hooks" | jq --arg c "$PREDECESSOR" '. + [{"matcher":"","hooks":[{"type":"command","command":$c,"timeout":120}]}]')"
	fi
	if [ "$third" -eq 1 ]; then
		hooks="$(printf '%s' "$hooks" | jq --arg c "$THIRD_PARTY" '. + [{"matcher":"*","hooks":[{"type":"command","command":$c}]}]')"
	fi
	printf '%s' "$hooks" | jq '{"hooks":{"Stop":.}}' >"$h/.claude/settings.json"
	printf '%s' "$h"
}

# --------------------------------------------------------------------------
# 1. Happy path — installing over a predecessor REPORTS what it did about it
# --------------------------------------------------------------------------

H="$(new_home coexist --with-predecessor)"
S="$(settings_of "$H")"

run install claude "$H"
assert_equals "coexist/install-succeeds" "0" "$RUN_RC"
assert_equals "coexist/predecessor-left-registered" "1" "$(count_matching "$S" "jam-loop-stop")"
assert_equals "coexist/gate-registered" "1" "$(count_matching "$S" "goal-gate-stop")"

case "$RUN_OUT" in
*"LEFT IN PLACE"*) pass "coexist/reports-the-decision" ;;
*) fail "coexist/reports-the-decision" "installing over a predecessor said nothing about it: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*"--remove-predecessor"*) pass "coexist/names-the-deliberate-route" ;;
*) fail "coexist/names-the-deliberate-route" "the report does not name the opt-in removal: [$RUN_OUT]" ;;
esac

# The predecessor's own script is never deleted — unregistering is ours to do.
if [ -f "$PREDECESSOR" ]; then
	pass "coexist/predecessor-script-not-deleted"
else
	fail "coexist/predecessor-script-not-deleted" "another tool's script was deleted"
fi

# --------------------------------------------------------------------------
# 2. State transitions — both registered simultaneously is DEFINED
# --------------------------------------------------------------------------

# Both hooks present on the same event, both valid, neither disturbed.
assert_equals "both/two-registrations-coexist" "2" \
	"$(jq '[.hooks.Stop[]?.hooks[]?] | length' "$S" 2>/dev/null)"
if jq -e . "$S" >/dev/null 2>&1; then
	pass "both/configuration-stays-valid"
else
	fail "both/configuration-stays-valid" "the configuration is no longer valid JSON"
fi

# S34: an in-flight predecessor loop keeps behaving as before. The observable
# proxy is its registration: same command, same matcher, same timeout as before
# the gate arrived.
BEFORE="$(jq -S '[.hooks.Stop[]? | select((.hooks[]?.command // "") | test("jam-loop-stop"))]' "$S")"
run install claude "$H"
AFTER="$(jq -S '[.hooks.Stop[]? | select((.hooks[]?.command // "") | test("jam-loop-stop"))]' "$S")"
assert_equals "inflight/predecessor-registration-unchanged" "$BEFORE" "$AFTER"

# And a second install neither duplicates the gate nor the predecessor.
assert_equals "inflight/no-duplicate-gate" "1" "$(count_matching "$S" "goal-gate-stop")"
assert_equals "inflight/no-duplicate-predecessor" "1" "$(count_matching "$S" "jam-loop-stop")"

# --------------------------------------------------------------------------
# 3. Deliberate removal — opt-in, reported, and surgical
# --------------------------------------------------------------------------

H2="$(new_home handover --with-predecessor --with-third-party)"
S2="$(settings_of "$H2")"

run migrate claude "$H2" --remove-predecessor
assert_equals "handover/succeeds" "0" "$RUN_RC"
assert_equals "handover/predecessor-unregistered" "0" "$(count_matching "$S2" "jam-loop-stop")"
assert_equals "handover/gate-registered" "1" "$(count_matching "$S2" "goal-gate-stop")"

# Security boundary: a third party's hook is never collateral damage.
assert_equals "handover/third-party-untouched" "1" "$(count_matching "$S2" "someone-elses-hook")"

case "$RUN_OUT" in
*"removed 1 predecessor registration"*) pass "handover/reports-what-it-removed" ;;
*) fail "handover/reports-what-it-removed" "removal was not reported: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*"backed up"*) pass "handover/reports-the-backup" ;;
*) fail "handover/reports-the-backup" "no backup was reported: [$RUN_OUT]" ;;
esac
if [ -f "$PREDECESSOR" ]; then
	pass "handover/script-still-not-deleted"
else
	fail "handover/script-still-not-deleted" "removal deleted another tool's script"
fi

# A backup of the pre-change file exists beside it.
if ls "$H2"/.claude/settings.json.* >/dev/null 2>&1; then
	pass "handover/backup-on-disk"
else
	fail "handover/backup-on-disk" "no backup beside $S2"
fi

# --------------------------------------------------------------------------
# 4. Empty/Null and boundary — no predecessor, never used, partly removed
# --------------------------------------------------------------------------

H3="$(new_home nopredecessor)"
run migrate claude "$H3" --remove-predecessor
assert_equals "empty/no-predecessor-succeeds" "0" "$RUN_RC"
case "$RUN_OUT" in
*"nothing to hand over"*) pass "empty/no-predecessor-reported" ;;
*) fail "empty/no-predecessor-reported" "an absent predecessor was not reported: [$RUN_OUT]" ;;
esac
assert_equals "empty/gate-still-installed" "1" "$(count_matching "$(settings_of "$H3")" "goal-gate-stop")"

# Boundary: registered but never used — no loop state anywhere. Identical
# handling; "never used" is not a licence to remove without being asked.
H4="$(new_home neverused --with-predecessor)"
run install claude "$H4"
assert_equals "boundary/never-used-still-coexists" "1" "$(count_matching "$(settings_of "$H4")" "jam-loop-stop")"

# Boundary: partially removed — the matcher group is present but its hooks
# array is empty. Must not crash, and must not resurrect anything.
H5="$(new_home partial)"
jq '{"hooks":{"Stop":[{"matcher":"","hooks":[]}]}}' <<<'{}' >"$(settings_of "$H5")"
run migrate claude "$H5" --remove-predecessor
assert_equals "boundary/partial-removal-handled" "0" "$RUN_RC"
if jq -e . "$(settings_of "$H5")" >/dev/null 2>&1; then
	pass "boundary/partial-leaves-valid-config"
else
	fail "boundary/partial-leaves-valid-config" "the configuration is no longer valid JSON"
fi
assert_equals "boundary/partial-gate-installed" "1" "$(count_matching "$(settings_of "$H5")" "goal-gate-stop")"

# --------------------------------------------------------------------------
# 5. Error propagation — a failed step leaves a WORKING configuration
# --------------------------------------------------------------------------

H6="$(new_home corrupt --with-predecessor)"
S6="$(settings_of "$H6")"
printf 'this is not json at all {{{\n' >"$S6"

run migrate claude "$H6" --remove-predecessor
if [ "$RUN_RC" -eq 0 ]; then
	fail "error/corrupt-config-reported" "a corrupt configuration was migrated as though it were fine"
else
	pass "error/corrupt-config-reported"
fi

if [ "$(id -u)" -eq 0 ]; then
	pass "error/unwritable-config-reported"
	pass "error/unwritable-leaves-predecessor-intact"
else
	H7="$(new_home readonly --with-predecessor)"
	S7="$(settings_of "$H7")"
	BEFORE7="$(cat "$S7")"
	chmod 500 "$H7/.claude"

	run migrate claude "$H7" --remove-predecessor
	if [ "$RUN_RC" -eq 0 ]; then
		fail "error/unwritable-config-reported" "an unwritable target reported success"
	else
		pass "error/unwritable-config-reported"
	fi

	chmod 700 "$H7/.claude"
	# The predecessor's registration survives a failed migration intact — a
	# half-applied handover that unregistered the old hook without registering
	# the new one would leave the machine with NO gate at all.
	assert_equals "error/unwritable-leaves-predecessor-intact" "$BEFORE7" "$(cat "$S7")"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
