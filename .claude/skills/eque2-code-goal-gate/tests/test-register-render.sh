#!/usr/bin/env bash
# test-register-render.sh — conformance suite for install.sh's REGISTRATION
# RENDERING (T3.1): both agents' registrations generated from ONE internal
# description, so the two can never diverge by hand-copying.
#
# WHAT THE A1 SPIKE CHANGED HERE. The task was written against assumption A1.b —
# that the second agent's registration object might differ in SHAPE, and that
# this rendering layer is where the difference would live. The spike settled it
# against real installed manifests and a real fired hook: the object shape and
# the payload field names are IDENTICAL across Claude Code and Codex. So there
# is no translation layer to build. The difference is the registration
# LOCATION, not the object.
#
# That makes this layer's job smaller but not smaller-value: one description,
# rendered once, written to two places. The assertion that matters is that the
# two renderings are the SAME OBJECT — because the moment they are produced
# independently, they drift, and a drifted registration means the gate runs
# under one agent and not the other while both look installed.
#
# NOTHING HERE TOUCHES REAL USER CONFIGURATION. Every path is a fixture under a
# temp directory. The charter names the installer as this feature's canary
# precisely because ~/.claude/settings.json and ~/.codex/config.toml are shared
# with tools this feature never heard of.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALL="${GOAL_GATE_INSTALL:-${TEST_DIR}/../install.sh}"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-render.XXXXXX")"
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

printf '== goal-gate registration rendering (T3.1) conformance suite ==\n'
printf 'install: %s\n\n' "$INSTALL"

if [ ! -f "$INSTALL" ]; then
	printf 'FATAL: install.sh not found at %s\n' "$INSTALL" >&2
	exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite.\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: both agents render from the one description --\n'
# ===========================================================================

CLAUDE_JSON="$(bash "$INSTALL" render claude 2>"$WORK_DIR/e1")"
RC=$?
assert_equals "happy/claude-renders" "0" "$RC"

CODEX_JSON="$(bash "$INSTALL" render codex 2>"$WORK_DIR/e2")"
RC2=$?
assert_equals "happy/codex-renders" "0" "$RC2"

if printf '%s' "$CLAUDE_JSON" | jq -e . >/dev/null 2>&1; then
	pass "happy/the-claude-rendering-is-valid-json"
else
	fail "happy/the-claude-rendering-is-valid-json" "[$CLAUDE_JSON]"
fi
if printf '%s' "$CODEX_JSON" | jq -e . >/dev/null 2>&1; then
	pass "happy/the-codex-rendering-is-valid-json"
else
	fail "happy/the-codex-rendering-is-valid-json" "[$CODEX_JSON]"
fi

# The registration must actually register a Stop hook running the gate.
assert_equals "happy/claude-registers-a-stop-hook" "command" \
	"$(printf '%s' "$CLAUDE_JSON" | jq -r '.hooks[0].type')"
assert_equals "happy/codex-registers-a-stop-hook" "command" \
	"$(printf '%s' "$CODEX_JSON" | jq -r '.hooks[0].type')"

case "$(printf '%s' "$CLAUDE_JSON" | jq -r '.hooks[0].command')" in
*goal-gate-stop.sh*) pass "happy/claude-points-at-the-gate" ;;
*) fail "happy/claude-points-at-the-gate" "command=[$(printf '%s' "$CLAUDE_JSON" | jq -r '.hooks[0].command')]" ;;
esac
case "$(printf '%s' "$CODEX_JSON" | jq -r '.hooks[0].command')" in
*goal-gate-stop.sh*) pass "happy/codex-points-at-the-gate" ;;
*) fail "happy/codex-points-at-the-gate" "command=[$(printf '%s' "$CODEX_JSON" | jq -r '.hooks[0].command')]" ;;
esac

# ===========================================================================
printf -- '-- 2. ONE description: the two renderings are the same object --\n'
# ===========================================================================
#
# The point of the task. Two independently-produced registrations drift, and a
# drifted registration means the gate runs under one agent and not the other
# while both look installed. Compared as normalised JSON, not as text, so
# key ordering and whitespace cannot mask a real difference.

NORM_CLAUDE="$(printf '%s' "$CLAUDE_JSON" | jq -S -c .)"
NORM_CODEX="$(printf '%s' "$CODEX_JSON" | jq -S -c .)"
assert_equals "single-source/the-two-renderings-are-identical" "$NORM_CLAUDE" "$NORM_CODEX"

# And the thing that DOES differ is the location, which is what A1 established.
CLAUDE_PATH="$(bash "$INSTALL" target-path claude "$WORK_DIR/fake-home" 2>/dev/null)"
CODEX_PATH="$(bash "$INSTALL" target-path codex "$WORK_DIR/fake-home" 2>/dev/null)"

if [ -n "$CLAUDE_PATH" ] && [ -n "$CODEX_PATH" ] && [ "$CLAUDE_PATH" != "$CODEX_PATH" ]; then
	pass "single-source/the-locations-differ-even-though-the-object-does-not"
else
	fail "single-source/the-locations-differ-even-though-the-object-does-not" \
		"claude=[$CLAUDE_PATH] codex=[$CODEX_PATH]"
fi

case "$CLAUDE_PATH" in
*.claude/settings.json) pass "single-source/claude-targets-settings-json" ;;
*) fail "single-source/claude-targets-settings-json" "[$CLAUDE_PATH]" ;;
esac
case "$CODEX_PATH" in
*.codex/hooks.json) pass "single-source/codex-targets-hooks-json" ;;
*) fail "single-source/codex-targets-hooks-json" "[$CODEX_PATH]" ;;
esac

# ===========================================================================
printf -- '-- 3. Invalid input: an unknown agent is REJECTED --\n'
# ===========================================================================
#
# Rejected, not defaulted. Silently rendering "the usual one" for a typo'd
# agent name installs the gate somewhere nobody asked for and reports success.

for bad in "claud" "CODEX-2" "" "../../etc/passwd" "claude codex"; do
	label="$(printf '%s' "$bad" | tr -c 'a-zA-Z0-9' '-' | cut -c1-16)"
	[ -n "$label" ] || label="empty"
	if bash "$INSTALL" render "$bad" >/dev/null 2>&1; then
		fail "unknown/${label}/is-rejected" "the unknown agent [$bad] rendered anyway"
	else
		pass "unknown/${label}/is-rejected"
	fi
done

bash "$INSTALL" render "nonsuch" >/dev/null 2>"$WORK_DIR/e3"
if grep -qi 'agent' "$WORK_DIR/e3" 2>/dev/null; then
	pass "unknown/the-rejection-names-the-problem"
else
	fail "unknown/the-rejection-names-the-problem" "stderr=[$(cat "$WORK_DIR/e3")]"
fi

# ===========================================================================
printf -- '-- 4. Boundary: a configuration file that does not yet exist --\n'
# ===========================================================================

FRESH="$WORK_DIR/fresh-home"
mkdir -p "$FRESH"
NEWPATH="$(bash "$INSTALL" target-path claude "$FRESH" 2>/dev/null)"
if [ -n "$NEWPATH" ] && [ ! -e "$NEWPATH" ]; then
	pass "boundary/a-missing-config-still-resolves-to-a-path"
else
	fail "boundary/a-missing-config-still-resolves-to-a-path" "[$NEWPATH]"
fi

# Resolving a path must not CREATE anything — resolution and mutation are
# separate steps, so a dry run cannot leave a trace.
if [ -e "$FRESH/.claude" ]; then
	fail "boundary/resolving-a-path-creates-nothing" "resolution created $FRESH/.claude"
else
	pass "boundary/resolving-a-path-creates-nothing"
fi

# ===========================================================================
printf -- '-- 5. Empty/Null: an empty existing configuration --\n'
# ===========================================================================

EMPTY_HOME="$WORK_DIR/empty-home"
mkdir -p "$EMPTY_HOME/.claude"
: >"$EMPTY_HOME/.claude/settings.json"

OUT5="$(bash "$INSTALL" render claude 2>/dev/null)"
if printf '%s' "$OUT5" | jq -e . >/dev/null 2>&1; then
	pass "empty/rendering-is-independent-of-existing-config"
else
	fail "empty/rendering-is-independent-of-existing-config" "[$OUT5]"
fi

# ===========================================================================
printf -- '-- 6. Error propagation: reported, with nothing partially written --\n'
# ===========================================================================

RO_HOME="$WORK_DIR/ro-home"
mkdir -p "$RO_HOME"
chmod a-w "$RO_HOME"

if [ -w "$RO_HOME" ]; then
	pass "errprop/an-unwritable-target-is-reported (skipped: running as root)"
	pass "errprop/nothing-was-partially-written (skipped: running as root)"
else
	bash "$INSTALL" check-writable claude "$RO_HOME" >/dev/null 2>"$WORK_DIR/e6"
	RC6=$?
	if [ "$RC6" -ne 0 ]; then
		pass "errprop/an-unwritable-target-is-reported"
	else
		fail "errprop/an-unwritable-target-is-reported" "an unwritable home reported success"
	fi

	if [ -e "$RO_HOME/.claude" ]; then
		fail "errprop/nothing-was-partially-written" "a partial .claude was created under an unwritable home"
	else
		pass "errprop/nothing-was-partially-written"
	fi
fi
chmod u+w "$RO_HOME"

# ===========================================================================
printf -- '-- 7. The registration carries what the host needs to run it --\n'
# ===========================================================================
#
# The budget is the tightest HOST timeout, and the gate enforces 120s itself
# (review finding R3). A registration whose timeout is SHORTER than the gate's
# own budget means the host kills the hook before it can refuse -- and a host
# that kills a hook may treat the dead hook as consent.

TIMEOUT="$(printf '%s' "$CLAUDE_JSON" | jq -r '.hooks[0].timeout // empty')"
if [ -n "$TIMEOUT" ] && [ "$TIMEOUT" -ge 120 ] 2>/dev/null; then
	pass "contract/the-timeout-is-at-least-the-gates-own-budget ($TIMEOUT)"
else
	fail "contract/the-timeout-is-at-least-the-gates-own-budget" \
		"timeout=[$TIMEOUT] — shorter than the budget means the host kills the hook before it can refuse"
fi

# The command must be an ABSOLUTE path: a relative one resolves against
# whatever directory the host happens to be in, which is not knowable.
CMD="$(printf '%s' "$CLAUDE_JSON" | jq -r '.hooks[0].command')"
case "$CMD" in
/*) pass "contract/the-command-is-an-absolute-path" ;;
*) fail "contract/the-command-is-an-absolute-path" "[$CMD]" ;;
esac

# ===========================================================================
printf '\n'
# --- T3.1 across the call shapes that actually occur -------------------------
#
# The invariant is "ONE description, rendered twice". It was only ever checked
# for the no-home case. install_home also blesses AGENT-SPECIFIC homes
# (`$H/.codex`), and under that shape the two renderings silently diverged into
# two different runtime trees and two different registered commands — T3.1
# broken through the back door, invisible because no test used that shape.
RR_H="$(mktemp -d)"
mkdir -p "$RR_H/.codex" "$RR_H/.claude"

RR_A="$(bash "$INSTALL" render claude "$RR_H")"
RR_B="$(bash "$INSTALL" render codex "$RR_H/.codex")"
if [ "$RR_A" = "$RR_B" ]; then
	pass "single-source/identical-under-an-agent-specific-home"
else
	fail "single-source/identical-under-an-agent-specific-home" \
		"claude=[$RR_A] codex=[$RR_B]"
fi

RR_C="$(bash "$INSTALL" render claude "$RR_H/.claude")"
if [ "$RR_C" = "$RR_B" ]; then
	pass "single-source/identical-when-both-are-agent-specific"
else
	fail "single-source/identical-when-both-are-agent-specific" \
		"claude=[$RR_C] codex=[$RR_B]"
fi
rm -rf "$RR_H"

if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
