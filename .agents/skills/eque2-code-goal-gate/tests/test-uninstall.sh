#!/usr/bin/env bash
# test-uninstall.sh — conformance suite for install.sh's UNINSTALL and
# DANGLING-COMMAND SAFETY (T3.6), and the PREDECESSOR MIGRATION (T5.1).
#
# Why uninstall is not an afterthought. The gate lives in a REPO CHECKOUT but is
# registered into user-global config by absolute path. Move, rename or delete
# that checkout and the registration still fires — on every turn, of every
# project, forever. Without a removal path that is a permanently broken agent,
# and the contract originally had none.
#
# THE ONE SANCTIONED FAIL-OPEN. Everywhere else in this feature an unknown
# resolves to NOT DONE. Here it must not: a gate whose command has vanished must
# NOT block the host session. Blocking every turn of every project because a
# checkout moved is a worse failure than letting a turn end unguarded — and the
# user in that state has no working agent with which to fix it. This is the
# single deliberate exception in the feature, and it is tested as such rather
# than left to chance.
#
# MIGRATION IS A REPORTED DECISION, NEVER A SILENT SIDE EFFECT. Removing someone
# else's working hook without saying so is exactly the clobbering this feature's
# canary exists to prevent. So the predecessor is detected, what happened to it
# is stated, and removal only happens when it is asked for.
#
# NOTHING HERE TOUCHES REAL USER CONFIGURATION — every fixture is a temp copy.
#
# Plain bash asserts — deliberately NOT bats. Exits non-zero on any FAIL.

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-uninstall.XXXXXX")"
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

gate_count() {
	jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | test("goal-gate-stop"))] | length' "$1" 2>/dev/null
}
foreign_count() {
	jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | test("jam-loop-stop"))] | length' "$1" 2>/dev/null
}

# new_home — the REAL shape: predecessor registered on Stop, unrelated settings.
new_home() {
	local h
	h="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
	h="$(cd -- "$h" && pwd -P)"
	mkdir -p "$h/.claude"
	cat >"$h/.claude/settings.json" <<'EOF'
{
  "model": "opus",
  "hooks": {
    "Stop": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/jam-loop-stop.sh"}]}
    ],
    "SessionStart": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "/opt/other-tool/session.sh"}]}
    ]
  }
}
EOF
	printf '%s' "$h"
}

printf '== goal-gate uninstall + migration (T3.6, T5.1) conformance suite ==\n'
printf 'install: %s\n\n' "$INSTALL"

command -v jq >/dev/null 2>&1 || {
	printf 'FATAL: jq required\n' >&2
	exit 1
}

# ===========================================================================
printf -- '-- 1. Uninstall removes ONLY the gate --\n'
# ===========================================================================

H="$(new_home)"
S="$H/.claude/settings.json"
bash "$INSTALL" install claude "$H" >/dev/null 2>&1
assert_equals "setup/the-gate-was-installed" "1" "$(gate_count "$S")"

bash "$INSTALL" uninstall claude "$H" >/dev/null 2>"$WORK_DIR/e1"
RC=$?
assert_equals "uninstall/succeeds" "0" "$RC"
assert_equals "uninstall/the-gate-is-gone" "0" "$(gate_count "$S")"
assert_equals "uninstall/the-third-party-hook-survives" "1" "$(foreign_count "$S")"
assert_equals "uninstall/unrelated-events-survive" "/opt/other-tool/session.sh" \
	"$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$S")"
assert_equals "uninstall/unrelated-settings-survive" "opus" "$(jq -r '.model' "$S")"

if jq -e . "$S" >/dev/null 2>&1; then
	pass "uninstall/the-config-is-still-valid-json"
else
	fail "uninstall/the-config-is-still-valid-json" "$(cat "$S")"
fi

# No orphaned empty matcher group left where the gate used to be.
EMPTY="$(jq '[.hooks.Stop[]? | select((.hooks // []) | length == 0)] | length' "$S" 2>/dev/null)"
assert_equals "uninstall/no-empty-group-is-left-behind" "0" "$EMPTY"

# ===========================================================================
printf -- '-- 2. Idempotent, and honest when there is nothing to do --\n'
# ===========================================================================

bash "$INSTALL" uninstall claude "$H" >/dev/null 2>"$WORK_DIR/e2"
RC2=$?
assert_equals "idempotent/a-second-uninstall-does-not-error" "0" "$RC2"
assert_equals "idempotent/the-third-party-hook-still-survives" "1" "$(foreign_count "$S")"

if grep -qi 'not registered\|nothing\|no goal-gate' "$WORK_DIR/e2" 2>/dev/null; then
	pass "idempotent/uninstalling-nothing-says-so"
else
	fail "idempotent/uninstalling-nothing-says-so" "stderr=[$(cat "$WORK_DIR/e2")]"
fi

# A config with no hooks at all must not be damaged by an uninstall.
H2="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H2/.claude"
printf '{"model":"opus"}' >"$H2/.claude/settings.json"
BEFORE2="$(cat "$H2/.claude/settings.json")"
bash "$INSTALL" uninstall claude "$H2" >/dev/null 2>&1
assert_equals "idempotent/a-config-without-hooks-is-untouched" \
	"$(printf '%s' "$BEFORE2" | jq -S -c .)" "$(jq -S -c . "$H2/.claude/settings.json")"

# ===========================================================================
printf -- '-- 3. THE SANCTIONED FAIL-OPEN: a dangling command must not block --\n'
# ===========================================================================
#
# Everywhere else an unknown resolves to NOT DONE. Here it must not. A gate
# whose command has vanished (checkout moved/renamed/deleted) must not block
# every turn of every project — the user in that state has no working agent
# left with which to fix it.

MISSING="$WORK_DIR/definitely-not-here/goal-gate-stop.sh"
OUT3="$(printf '%s' '{"session_id":"dangle"}' | bash "$MISSING" 2>/dev/null)"
RC3=$?

if [ -z "$OUT3" ]; then
	pass "dangling/a-missing-gate-emits-no-block-decision"
else
	fail "dangling/a-missing-gate-emits-no-block-decision" \
		"a missing command produced stdout [$OUT3] — a host would read that as a decision"
fi
if [ "$RC3" -ne 0 ]; then
	pass "dangling/a-missing-gate-fails-visibly-to-the-host"
else
	fail "dangling/a-missing-gate-fails-visibly-to-the-host" "rc=$RC3"
fi

# Present but not executable: same requirement.
NOEXEC="$WORK_DIR/noexec-gate.sh"
printf '#!/usr/bin/env bash\nprintf %s\n' '{"decision":"block"}' >"$NOEXEC"
chmod a-x "$NOEXEC"
OUT3B="$("$NOEXEC" 2>/dev/null </dev/null)"
if [ -z "$OUT3B" ]; then
	pass "dangling/a-non-executable-gate-emits-no-block-decision"
else
	fail "dangling/a-non-executable-gate-emits-no-block-decision" "[$OUT3B]"
fi

# And the installer can REPORT the condition rather than leaving it silent.
#
# Constructed the way it actually arises: install normally, then the gate file
# goes away (checkout moved, renamed, deleted, or the shared runtime tree
# cleaned). The registration in the config is now dangling.
#
# NOT via GOAL_GATE_STOP_PATH at install time any more: `install` refuses to
# write a registration whose command is not executable, precisely so a
# fail-open cannot be created by installing. Removing the file AFTER install is
# the honest reproduction, and it exercises the same doctor path.
H3="$(new_home)"
bash "$INSTALL" install claude "$H3" >/dev/null 2>&1
GATE3="$(bash "$INSTALL" gate-path "$H3")"
rm -f "$GATE3"
bash "$INSTALL" doctor claude "$H3" >/dev/null 2>"$WORK_DIR/e3"
if grep -qi 'not found\|missing\|does not exist' "$WORK_DIR/e3" 2>/dev/null; then
	pass "dangling/the-installer-reports-a-registration-it-cannot-run"
else
	fail "dangling/the-installer-reports-a-registration-it-cannot-run" "stderr=[$(cat "$WORK_DIR/e3")]"
fi

# ===========================================================================
printf -- '-- 4. Migration: the predecessor is DETECTED and REPORTED --\n'
# ===========================================================================

H4="$(new_home)"
S4="$H4/.claude/settings.json"
bash "$INSTALL" install claude "$H4" >/dev/null 2>"$WORK_DIR/e4"

if grep -qi 'jam-loop\|predecessor' "$WORK_DIR/e4" 2>/dev/null; then
	pass "migration/installing-beside-a-predecessor-reports-it"
else
	fail "migration/installing-beside-a-predecessor-reports-it" "stderr=[$(cat "$WORK_DIR/e4")]"
fi

# Default is COEXIST: the predecessor is left working. Removing someone's
# working hook as a side effect of installing is the clobbering the canary
# exists to prevent.
assert_equals "migration/the-predecessor-is-left-in-place-by-default" "1" "$(foreign_count "$S4")"
assert_equals "migration/the-gate-is-installed-alongside-it" "1" "$(gate_count "$S4")"

# ===========================================================================
printf -- '-- 5. Migration: removal is EXPLICIT and reported --\n'
# ===========================================================================

H5="$(new_home)"
S5="$H5/.claude/settings.json"
bash "$INSTALL" migrate claude "$H5" --remove-predecessor >/dev/null 2>"$WORK_DIR/e5"
RC5=$?
assert_equals "migrate/succeeds" "0" "$RC5"
assert_equals "migrate/the-gate-is-registered" "1" "$(gate_count "$S5")"
assert_equals "migrate/the-predecessor-registration-is-removed" "0" "$(foreign_count "$S5")"
assert_equals "migrate/unrelated-events-still-survive" "/opt/other-tool/session.sh" \
	"$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$S5")"

if grep -qi 'removed' "$WORK_DIR/e5" 2>/dev/null; then
	pass "migrate/the-removal-is-reported-not-silent"
else
	fail "migrate/the-removal-is-reported-not-silent" "stderr=[$(cat "$WORK_DIR/e5")]"
fi

# A backup must exist — the predecessor is recoverable.
if find "$H5/.claude" -name 'settings.json.goal-gate-backup*' | grep -q .; then
	pass "migrate/a-backup-makes-the-predecessor-recoverable"
else
	fail "migrate/a-backup-makes-the-predecessor-recoverable" "no backup written"
fi

# Migration with NO predecessor present is not an error.
H6="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H6/.claude"
printf '{"model":"opus"}' >"$H6/.claude/settings.json"
bash "$INSTALL" migrate claude "$H6" --remove-predecessor >/dev/null 2>"$WORK_DIR/e6"
RC6=$?
assert_equals "migrate/no-predecessor-is-not-an-error" "0" "$RC6"
assert_equals "migrate/the-gate-is-still-installed" "1" "$(gate_count "$H6/.claude/settings.json")"

# The predecessor's own files are NEVER deleted — only the registration. The
# script belongs to another tool; unregistering is ours to do, deleting is not.
# Look for an actual deletion COMMAND naming the predecessor, not the word
# "deleted" -- which appears in the report that says it was NOT deleted. A naive
# grep fails a correct implementation on its own documentation.
if grep -nE '^[^#]*\b(rm|unlink|mv)\b[^|]*jam-loop' "$INSTALL" 2>/dev/null | grep -qv 'printf'; then
	fail "migrate/the-predecessor-script-is-never-deleted" \
		"install.sh contains a command that removes predecessor FILES: $(grep -nE '^[^#]*\b(rm|unlink|mv)\b[^|]*jam-loop' "$INSTALL" | head -2)"
else
	pass "migrate/the-predecessor-script-is-never-deleted"
fi

# And positively: the predecessor script itself survives a migration.
PRED_FIXTURE="$WORK_DIR/pred-home"
mkdir -p "$PRED_FIXTURE/.claude/hooks"
printf '#!/usr/bin/env bash\n# pretend predecessor\n' >"$PRED_FIXTURE/.claude/hooks/jam-loop-stop.sh"
cat >"$PRED_FIXTURE/.claude/settings.json" <<'PEOF'
{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"$HOME/.claude/hooks/jam-loop-stop.sh"}]}]}}
PEOF
bash "$INSTALL" migrate claude "$PRED_FIXTURE" --remove-predecessor >/dev/null 2>&1
if [ -f "$PRED_FIXTURE/.claude/hooks/jam-loop-stop.sh" ]; then
	pass "migrate/the-predecessor-script-file-still-exists-afterwards"
else
	fail "migrate/the-predecessor-script-file-still-exists-afterwards" "the migration deleted the predecessor script"
fi

# ===========================================================================
printf -- '-- 6. Non-vacuity: uninstall really removed something --\n'
# ===========================================================================

H7="$(new_home)"
S7="$H7/.claude/settings.json"
bash "$INSTALL" install claude "$H7" >/dev/null 2>&1
WITH="$(gate_count "$S7")"
bash "$INSTALL" uninstall claude "$H7" >/dev/null 2>&1
WITHOUT="$(gate_count "$S7")"
if [ "$WITH" = "1" ] && [ "$WITHOUT" = "0" ]; then
	pass "nonvacuous/the-gate-went-from-present-to-absent"
else
	fail "nonvacuous/the-gate-went-from-present-to-absent" "with=[$WITH] without=[$WITHOUT]"
fi

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
