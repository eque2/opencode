#!/usr/bin/env bash
# test-codex-shape-spike.sh — the regression guard for what the A1 spike settled
# about Codex.
#
# The spike answered three questions with a real `codex-cli 0.144.5` session, and
# every answer is now load-bearing somewhere in this feature:
#
#   1. The hook OBJECT shape is identical to Claude Code's, so there is no
#      translation layer — `install.sh` renders one description twice.
#   2. The PAYLOAD carries `session_id` AND `turn_id`. Binding hangs off that:
#      `session_id` is stable across turns, `turn_id` is not, and `turn_id` is
#      the field that discriminates the two agents.
#   3. Codex SILENTLY SKIPS a hook it does not trust. Everything about how this
#      feature reports installation follows from that one fact.
#
# A spike's findings decay the moment nobody checks them. This suite pins all
# three against the recorded artefact, so a change that quietly invalidates one
# fails here rather than in someone's session six months from now.
#
# It asserts against `live-evidence/codex-stop-payload.json` — a VERBATIM payload
# captured from a real Codex Stop hook, not a hand-written fixture. Re-capture it
# with `GOAL_GATE_LIVE=1 bash test-live-registration.sh`.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${TEST_DIR}/../goal-gate-stop.sh"
INSTALL="${TEST_DIR}/../install.sh"
EVIDENCE="${TEST_DIR}/../live-evidence"
PAYLOAD="$EVIDENCE/codex-stop-payload.json"

PASS_COUNT=0
FAIL_COUNT=0

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

# --------------------------------------------------------------------------
# 0. The artefact itself — everything below is vacuous without it
# --------------------------------------------------------------------------

if [ -s "$PAYLOAD" ]; then
	pass "spike/recorded-payload-present"
else
	fail "spike/recorded-payload-present" "no captured Codex payload at $PAYLOAD; every assertion below would be vacuous"
	printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 1
fi

if jq -e . "$PAYLOAD" >/dev/null 2>&1; then
	pass "spike/recorded-payload-is-valid-json"
else
	fail "spike/recorded-payload-is-valid-json" "the captured payload does not parse"
	printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 1
fi

# --------------------------------------------------------------------------
# 1. Finding one — the hook object shape is IDENTICAL, so there is no
#    translation layer to maintain
# --------------------------------------------------------------------------

CLAUDE_OBJ="$(bash "$INSTALL" render claude 2>/dev/null)"
CODEX_OBJ="$(bash "$INSTALL" render codex 2>/dev/null)"

if [ -n "$CLAUDE_OBJ" ] && [ -n "$CODEX_OBJ" ]; then
	pass "shape/both-renderings-were-produced"
	assert_equals "shape/renderings-are-identical" "$CLAUDE_OBJ" "$CODEX_OBJ"
else
	fail "shape/both-renderings-were-produced" "one or both renderings were empty; the comparison below would pass vacuously"
	fail "shape/renderings-are-identical" "not attempted"
fi

# The shape itself, so a change to BOTH renderings at once still fails here.
for field in matcher hooks; do
	if printf '%s' "$CLAUDE_OBJ" | jq -e --arg f "$field" 'has($f)' >/dev/null 2>&1; then
		pass "shape/object-has-$field"
	else
		fail "shape/object-has-$field" "the rendered registration lacks .$field"
	fi
done
assert_equals "shape/command-type-is-command" "command" \
	"$(printf '%s' "$CLAUDE_OBJ" | jq -r '.hooks[0].type' 2>/dev/null)"

# The LOCATIONS differ — that is the whole divergence, and it is real.
CLAUDE_PATH="$(bash "$INSTALL" target-path claude "/tmp/fixture" 2>/dev/null)"
CODEX_PATH="$(bash "$INSTALL" target-path codex "/tmp/fixture" 2>/dev/null)"
if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_PATH" != "$CODEX_PATH" ]; then
	pass "shape/locations-differ"
else
	fail "shape/locations-differ" "the two agents resolved to the same config path [$CLAUDE_PATH]"
fi
case "$CODEX_PATH" in
*/hooks.json) pass "shape/codex-writes-its-own-hooks-file" ;;
*) fail "shape/codex-writes-its-own-hooks-file" "unexpected Codex target: $CODEX_PATH" ;;
esac
case "$CLAUDE_PATH" in
*/settings.json) pass "shape/claude-writes-settings-json" ;;
*) fail "shape/claude-writes-settings-json" "unexpected Claude target: $CLAUDE_PATH" ;;
esac

# --------------------------------------------------------------------------
# 2. Finding two — the payload carries BOTH identities
# --------------------------------------------------------------------------

for field in session_id turn_id hook_event_name cwd; do
	if jq -e --arg f "$field" 'has($f) and (.[$f] | type == "string") and (.[$f] | length > 0)' \
		"$PAYLOAD" >/dev/null 2>&1; then
		pass "payload/carries-$field"
	else
		fail "payload/carries-$field" "the recorded Codex payload has no usable .$field"
	fi
done

assert_equals "payload/event-is-stop" "Stop" "$(jq -r '.hook_event_name' "$PAYLOAD")"

# `stop_hook_active` is present and boolean — the recursion signal the gate's
# bound depends on.
if jq -e 'has("stop_hook_active") and (.stop_hook_active | type == "boolean")' "$PAYLOAD" >/dev/null 2>&1; then
	pass "payload/carries-stop_hook_active"
else
	fail "payload/carries-stop_hook_active" "no boolean .stop_hook_active in the recorded payload"
fi

# The two ids are DISTINCT. If they were ever the same value, binding to
# session_id would silently become binding to a per-turn id — a workstream that
# unbinds itself every turn.
SID="$(jq -r '.session_id' "$PAYLOAD")"
TID="$(jq -r '.turn_id' "$PAYLOAD")"
if [ -n "$SID" ] && [ "$SID" != "$TID" ]; then
	pass "payload/session-and-turn-ids-are-distinct"
else
	fail "payload/session-and-turn-ids-are-distinct" "session_id and turn_id are the same value [$SID]"
fi

# --------------------------------------------------------------------------
# 3. The consequence — the gate must LABEL this payload codex, not claude
#
# The recorded payload carries both ids, so testing session_id first labelled
# every Codex run `claude` in its own run log. turn_id is the discriminating
# field: Claude payloads carry none.
# --------------------------------------------------------------------------

# shellcheck disable=SC2016  # `$have_turn` is the literal text being searched for
if grep -q 'have_turn.*-eq 1' "$GATE" && grep -A2 'if \[ "\$have_turn" -eq 1 \]' "$GATE" | grep -q 'agent="codex"'; then
	pass "detection/turn_id-is-tested-first"
else
	fail "detection/turn_id-is-tested-first" "the gate does not discriminate on turn_id first; a Codex run would be labelled claude"
fi

# Detection is still by SHARED field — neither id is mandatory on its own, so a
# payload carrying only one of them is still bindable.
if grep -q 'have_session' "$GATE" && grep -q 'agent="claude"' "$GATE"; then
	pass "detection/session-only-payloads-still-bind"
else
	fail "detection/session-only-payloads-still-bind" "the session-only path is gone; Claude payloads would not bind"
fi

# --------------------------------------------------------------------------
# 4. Finding three — the trust behaviour, and that nothing claims otherwise
# --------------------------------------------------------------------------

README="$EVIDENCE/README.md"
trust_states() {
	if grep -Eqi -- "$2" "$README" 2>/dev/null; then
		pass "trust/$1"
	else
		fail "trust/$1" "the evidence README does not record: $2"
	fi
}

trust_states "silent-skip-is-recorded" 'did not fire|silent skip'
trust_states "the-skip-is-reported-as-silent" 'no error, no warning|no warning'
trust_states "the-override-is-named" 'dangerously-bypass-hook-trust'
trust_states "trust-is-still-open" 'bypassed.*not.*persisted|still open'

# The installer must never claim a written registration proves the gate runs.
DOCTOR_OUT="$(bash "$INSTALL" doctor claude 2>&1)"
case "$DOCTOR_OUT" in
*"not proof"*|*"silently skipped"*|*"not registered"*) pass "trust/doctor-does-not-overclaim" ;;
*) fail "trust/doctor-does-not-overclaim" "doctor reports without the firing caveat: [$DOCTOR_OUT]" ;;
esac

# And the installer's own header must still carry the finding, so the next
# reader of that file cannot mistake registration for installation.
if grep -qi "silently skips" "$INSTALL"; then
	pass "trust/installer-records-the-finding"
else
	fail "trust/installer-records-the-finding" "install.sh no longer records that Codex silently skips untrusted hooks"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
