#!/usr/bin/env bash
# test-install-absent.sh — the honest no-agent report (T3.3).
#
# Fail-closed applies to INSTALLATION, not just to the gate's decision. An
# installer that finds no agent, registers nothing and exits 0 has told the
# reader the gate is in place. They run `pursue-goal`, it refuses, and the
# failure surfaces one layer away from its cause.
#
# The third state is the point of this suite. "Undetected" is not folded into
# "absent": an agent whose home cannot be read is an unanswered question, and
# answering it "absent" is a guess printed as a fact.
#
# Every test runs against a FIXTURE home with a stripped PATH. Nothing here
# touches the real `$HOME/.claude` or `$CODEX_HOME`.
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

# A PATH with the shell built-ins available but NO agent binary on it, so
# "absent" can be produced without uninstalling anything from the machine.
# Built by MIRRORING the real PATH and omitting only the two agent binaries, so
# every tool the installer legitimately uses stays available. Enumerating what
# it needs by hand is how this suite fails for reasons that are not defects.
BARE_PATH="$WORK_DIR/bin"
mkdir -p -- "$BARE_PATH"
IFS=: read -r -a PATH_DIRS <<<"$PATH"
for d in "${PATH_DIRS[@]}"; do
	[ -d "$d" ] || continue
	for f in "$d"/*; do
		[ -x "$f" ] || continue
		name="$(basename -- "$f")"
		case "$name" in
		claude | codex) continue ;;
		esac
		[ -e "$BARE_PATH/$name" ] || ln -sf "$f" "$BARE_PATH/$name"
	done
done

if command -v claude >/dev/null 2>&1 && PATH="$BARE_PATH" command -v claude >/dev/null 2>&1; then
	printf 'the stripped PATH still exposes an agent binary; this suite cannot run\n' >&2
	exit 1
fi

# detect <agent> <home> — with the stripped PATH.
detect() {
	PATH="$BARE_PATH" bash "$INSTALL" detect "$1" "$2" 2>/dev/null
}

RUN_OUT=""
RUN_RC=0
install_all() {
	RUN_OUT="$(PATH="$BARE_PATH" bash "$INSTALL" install-all "$1" 2>&1)"
	RUN_RC=$?
}

# --------------------------------------------------------------------------
# 1. Detection states
# --------------------------------------------------------------------------

H_NONE="$WORK_DIR/none"
mkdir -p -- "$H_NONE"
assert_equals "detect/absent-claude" "absent" "$(detect claude "$H_NONE")"
assert_equals "detect/absent-codex" "absent" "$(detect codex "$H_NONE")"

# A config home alone is enough: a user may have installed an agent without
# ever running it, or run it from a path this shell cannot see.
H_ONE="$WORK_DIR/one"
mkdir -p -- "$H_ONE/.claude"
assert_equals "detect/present-by-home" "present" "$(detect claude "$H_ONE")"
assert_equals "detect/other-still-absent" "absent" "$(detect codex "$H_ONE")"

# Empty/Null: a config directory that exists and is genuinely EMPTY — its own
# fixture, not a re-test of the line above, which used the same directory.
H_EMPTYDIR="$WORK_DIR/emptydir"
mkdir -p -- "$H_EMPTYDIR/.claude"
assert_equals "detect/empty-config-dir-is-present" "present" "$(detect claude "$H_EMPTYDIR")"
assert_equals "detect/empty-config-dir-has-no-files" "0" \
	"$(find "$H_EMPTYDIR/.claude" -type f 2>/dev/null | wc -l | tr -d ' ')"

# Error propagation: undetectable is NOT absent.
H_FILE="$WORK_DIR/file-home"
mkdir -p -- "$H_FILE"
printf 'not a directory\n' >"$H_FILE/.claude"
assert_equals "detect/home-is-a-file-undetected" "undetected" "$(detect claude "$H_FILE")"

if [ "$(id -u)" -eq 0 ]; then
	pass "detect/unreadable-home-undetected"
else
	H_UNREAD="$WORK_DIR/unreadable"
	mkdir -p -- "$H_UNREAD/.claude"
	chmod 000 "$H_UNREAD/.claude"
	assert_equals "detect/unreadable-home-undetected" "undetected" "$(detect claude "$H_UNREAD")"
	chmod 700 "$H_UNREAD/.claude"
fi

RUN_OUT="$(bash "$INSTALL" detect bogus "$H_NONE" 2>&1)"
RUN_RC=$?
assert_equals "detect/unknown-agent-rejected" "2" "$RUN_RC"

# --------------------------------------------------------------------------
# 2. Happy path — neither agent present is a FAILURE, not a no-op
# --------------------------------------------------------------------------

H_EMPTY="$WORK_DIR/empty-machine"
mkdir -p -- "$H_EMPTY"
install_all "$H_EMPTY"

if [ "$RUN_RC" -eq 0 ]; then
	fail "absent/reports-non-success" "no agent present, yet the installer reported SUCCESS"
else
	pass "absent/reports-non-success"
fi
case "$RUN_OUT" in
*"NOTHING is installed"*) pass "absent/says-nothing-is-installed" ;;
*) fail "absent/says-nothing-is-installed" "the report does not say nothing was installed: [$RUN_OUT]" ;;
esac
# Both agents, and the specific sentence — `claude` alone matched every path
# the installer prints (`.claude/settings.json`) and the script's own name, so
# it would have passed over a report that named neither agent's status.
NAMED_BOTH=1
case "$RUN_OUT" in
*"claude — not installed"*) : ;;
*) NAMED_BOTH=0 ;;
esac
case "$RUN_OUT" in
*"codex — not installed"*) : ;;
*) NAMED_BOTH=0 ;;
esac
assert_equals "absent/names-each-agent" "1" "$NAMED_BOTH"

# It registered NOTHING — the report and the filesystem must agree.
if [ -e "$H_EMPTY/.claude/settings.json" ] || [ -e "$H_EMPTY/.codex/hooks.json" ]; then
	fail "absent/registers-nothing" "a registration was written despite no agent being present"
else
	pass "absent/registers-nothing"
fi

# --------------------------------------------------------------------------
# 3. Boundary — exactly one agent present
# --------------------------------------------------------------------------

H_SOLO="$WORK_DIR/solo"
mkdir -p -- "$H_SOLO/.claude"
install_all "$H_SOLO"

assert_equals "single/succeeds" "0" "$RUN_RC"
# The message must say the skills were PLACED as well as the hook registered:
# "registered" alone is what the installer used to report while placing no
# skills at all, leaving pursue-goal undiscoverable under Codex.
case "$RUN_OUT" in
*"claude — detected, registered, and skills placed"*) pass "single/reports-which-was-registered" ;;
*) fail "single/reports-which-was-registered" "the report does not confirm registration AND placement: [$RUN_OUT]" ;;
esac

if [ -f "$H_SOLO/.claude/skills/eque2-code-pursue-goal/SKILL.md" ]; then
	pass "single/install-all-places-the-skills"
else
	fail "single/install-all-places-the-skills" "install-all registered the hook but placed no skills — pursue-goal would not exist as a command"
fi
case "$RUN_OUT" in
*"codex — not installed"*) pass "single/reports-which-was-skipped" ;;
*) fail "single/reports-which-was-skipped" "the report does not name the absent agent: [$RUN_OUT]" ;;
esac
if [ -f "$H_SOLO/.claude/settings.json" ]; then
	pass "single/registration-written"
else
	fail "single/registration-written" "no registration at $H_SOLO/.claude/settings.json"
fi
if [ -e "$H_SOLO/.codex/hooks.json" ]; then
	fail "single/absent-agent-untouched" "a registration was written for the absent agent"
else
	pass "single/absent-agent-untouched"
fi

# A written registration is never claimed as proof the gate fires.
case "$RUN_OUT" in
*"not proof the gate FIRES"*) pass "single/does-not-overclaim" ;;
*) fail "single/does-not-overclaim" "success is claimed without the firing caveat: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 4. Error propagation — an undetected agent is reported as undetected
# --------------------------------------------------------------------------

H_MIX="$WORK_DIR/mixed"
mkdir -p -- "$H_MIX/.claude"
printf 'not a directory\n' >"$H_MIX/.codex"
install_all "$H_MIX"

assert_equals "undetected/other-agent-still-installed" "0" "$RUN_RC"
case "$RUN_OUT" in
*"could NOT be detected"*) pass "undetected/reported-as-undetected" ;;
*) fail "undetected/reported-as-undetected" "an undetectable agent was not reported as such: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*"not an absence"*) pass "undetected/distinguished-from-absent" ;;
*) fail "undetected/distinguished-from-absent" "undetected was reported as though it were absence: [$RUN_OUT]" ;;
esac
assert_equals "undetected/nothing-written-for-it" "not a directory" "$(cat "$H_MIX/.codex")"

# Both agents undetectable is still a failure, and is not reported as absence.
H_BOTH="$WORK_DIR/both-undetected"
mkdir -p -- "$H_BOTH"
printf 'x\n' >"$H_BOTH/.claude"
printf 'x\n' >"$H_BOTH/.codex"
install_all "$H_BOTH"
if [ "$RUN_RC" -eq 0 ]; then
	fail "undetected/both-is-a-failure" "two undetectable agents reported success"
else
	pass "undetected/both-is-a-failure"
fi
case "$RUN_OUT" in
*"2 undetected"*) pass "undetected/counted-separately" ;;
*) fail "undetected/counted-separately" "the summary does not count undetected separately: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
