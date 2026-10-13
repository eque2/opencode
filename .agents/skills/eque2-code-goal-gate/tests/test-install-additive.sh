#!/usr/bin/env bash
# test-install-additive.sh — conformance suite for install.sh's ADDITIVE,
# IDEMPOTENT registration (T3.2).
#
# The property: adding the gate's registration preserves EVERYTHING already in
# the file, and running the installer repeatedly produces exactly one gate
# registration.
#
# This is not a hypothetical concern. On the development machine right now:
#   ~/.claude/settings.json   registers the PREDECESSOR the predecessor stop hook on Stop
#                             — the mechanism currently enforcing /goal sessions
#   ~/.codex/config.toml      carries a third-party [hooks.state] table with
#                             five warp@codex-warp entries, including :stop:0:0
#
# A clobbering installer breaks software this feature never touched, in shared
# user configuration, affecting every project on the machine. So "preserve
# unrelated content" is asserted against the REAL SHAPES those files have, not
# against a convenient minimal fixture.
#
# NOTHING HERE TOUCHES REAL USER CONFIGURATION. Every fixture is a copy under a
# temp directory. That is the charter's canary ordering, and it is mandatory
# rather than advisory precisely because the blast radius is other people's
# tools.
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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-install.XXXXXX")"
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

# new_home — a fixture HOME with a .claude/settings.json shaped like the real
# one: a matcher-group array on Stop, an unrelated third-party registration
# already present, and unrelated top-level settings beside it.
new_home() {
	local h
	h="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
	h="$(cd -- "$h" && pwd -P)"
	mkdir -p "$h/.claude"
	cat >"$h/.claude/settings.json" <<'EOF'
{
  "model": "opus",
  "env": {"SOME_TOKEN": "s3cret-value-that-must-survive"},
  "permissions": {"allow": ["Bash(npm test)"]},
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {"type": "command", "command": "/Users/someone/.claude/hooks/jam-loop-stop.sh", "timeout": 60}
        ]
      }
    ],
    "SessionStart": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "/opt/other-tool/session.sh"}]}
    ]
  }
}
EOF
	printf '%s' "$h"
}

gate_count() {
	jq '[.hooks.Stop[]?.hooks[]? | select(.command | test("goal-gate-stop"))] | length' "$1" 2>/dev/null
}

# Groups (not entries) whose hook list mentions the gate. A duplicate can hide
# one level up, and a reader counting entries would not see it.
group_count() {
	jq '[.hooks.Stop[]? | select(any(.hooks[]?; (.command // "") | test("goal-gate-stop")))] | length' "$1" 2>/dev/null
}

foreign_count() {
	jq '[.hooks.Stop[]?.hooks[]? | select(.command | test("jam-loop-stop"))] | length' "$1" 2>/dev/null
}

printf '== goal-gate additive installation (T3.2) conformance suite ==\n'
printf 'install: %s\n\n' "$INSTALL"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite.\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: a fresh install registers the gate --\n'
# ===========================================================================

H="$(new_home)"
S="$H/.claude/settings.json"
bash "$INSTALL" install claude "$H" >/dev/null 2>"$WORK_DIR/e1"
RC=$?
assert_equals "happy/install-succeeds" "0" "$RC"
assert_equals "happy/the-gate-is-registered-once" "1" "$(gate_count "$S")"

if jq -e . "$S" >/dev/null 2>&1; then
	pass "happy/the-file-is-still-valid-json"
else
	fail "happy/the-file-is-still-valid-json" "$(cat "$S")"
fi

# ===========================================================================
printf -- '-- 2. The third-party registration SURVIVES (this is real) --\n'
# ===========================================================================

assert_equals "preserve/the-predecessor-stop-hook-survives" "1" "$(foreign_count "$S")"
assert_equals "preserve/its-timeout-is-untouched" "60" \
	"$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("jam-loop-stop"))][0].timeout' "$S")"
assert_equals "preserve/unrelated-events-survive" "/opt/other-tool/session.sh" \
	"$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$S")"
assert_equals "preserve/unrelated-top-level-settings-survive" "opus" "$(jq -r '.model' "$S")"
assert_equals "preserve/credentials-in-the-file-survive" "s3cret-value-that-must-survive" \
	"$(jq -r '.env.SOME_TOKEN' "$S")"
assert_equals "preserve/unrelated-permissions-survive" "Bash(npm test)" \
	"$(jq -r '.permissions.allow[0]' "$S")"

# ===========================================================================
printf -- '-- 3. Idempotent: twice, three times, still exactly one --\n'
# ===========================================================================

bash "$INSTALL" install claude "$H" >/dev/null 2>&1
assert_equals "idempotent/a-second-run-adds-no-duplicate" "1" "$(gate_count "$S")"
bash "$INSTALL" install claude "$H" >/dev/null 2>&1
assert_equals "idempotent/a-third-run-adds-no-duplicate" "1" "$(gate_count "$S")"

# Nor a second matcher GROUP holding the same hook — the duplicate can hide one
# level up, and a reader counting groups would not see it.
assert_equals "idempotent/no-second-matcher-group-was-added" "1" "$(group_count "$S")"
assert_equals "idempotent/the-third-party-hook-is-still-there-after-3-runs" "1" "$(foreign_count "$S")"

# ===========================================================================
printf -- '-- 4. A backup is written BEFORE the file is modified --\n'
# ===========================================================================

H2="$(new_home)"
S2="$H2/.claude/settings.json"
ORIGINAL="$(cat "$S2")"
bash "$INSTALL" install claude "$H2" >/dev/null 2>&1

BACKUP="$(find "$H2/.claude" -name 'settings.json.goal-gate-backup*' | head -1)"
if [ -n "$BACKUP" ]; then
	pass "backup/a-backup-was-written"
	assert_equals "backup/the-backup-is-the-pre-install-content" "$ORIGINAL" "$(cat "$BACKUP")"
else
	fail "backup/a-backup-was-written" "no backup found in $H2/.claude"
	fail "backup/the-backup-is-the-pre-install-content" "no backup to compare"
fi

# ===========================================================================
printf -- '-- 5. Empty/Null: absent, empty, and invalid configurations --\n'
# ===========================================================================

# Absent → created correctly.
H3="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
bash "$INSTALL" install claude "$H3" >/dev/null 2>&1
S3="$H3/.claude/settings.json"
if [ -f "$S3" ]; then
	pass "absent/a-missing-config-is-created"
	assert_equals "absent/the-gate-is-registered-in-it" "1" "$(gate_count "$S3")"
else
	fail "absent/a-missing-config-is-created" "no file at $S3"
	fail "absent/the-gate-is-registered-in-it" "no file"
fi

# Empty file → treated as an empty object, not as corruption.
H4="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H4/.claude"
: >"$H4/.claude/settings.json"
bash "$INSTALL" install claude "$H4" >/dev/null 2>&1
assert_equals "empty/an-empty-config-gains-the-registration" "1" "$(gate_count "$H4/.claude/settings.json")"

# Invalid JSON → REPORTED and LEFT UNTOUCHED. Overwriting it would destroy
# settings the user can no longer recover, to fix a problem we did not cause.
H5="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H5/.claude"
printf '{ this is not json at all ' >"$H5/.claude/settings.json"
BEFORE5="$(cat "$H5/.claude/settings.json")"
bash "$INSTALL" install claude "$H5" >/dev/null 2>"$WORK_DIR/e5"
RC5=$?
if [ "$RC5" -ne 0 ]; then
	pass "invalid/an-unparseable-config-is-refused"
else
	fail "invalid/an-unparseable-config-is-refused" "the installer reported success over invalid JSON"
fi
assert_equals "invalid/the-unparseable-config-is-left-untouched" "$BEFORE5" "$(cat "$H5/.claude/settings.json")"
if grep -qi 'json\|parse\|invalid' "$WORK_DIR/e5" 2>/dev/null; then
	pass "invalid/the-refusal-explains-why"
else
	fail "invalid/the-refusal-explains-why" "stderr=[$(cat "$WORK_DIR/e5")]"
fi

# JSONC (comments) → reported with a remediation message, never mangled. jq
# cannot read it, and stripping comments would silently rewrite the user's file.
H6="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H6/.claude"
cat >"$H6/.claude/settings.json" <<'EOF'
{
  // this comment is why jq cannot read the file
  "model": "opus"
}
EOF
BEFORE6="$(cat "$H6/.claude/settings.json")"
bash "$INSTALL" install claude "$H6" >/dev/null 2>"$WORK_DIR/e6"
RC6=$?
if [ "$RC6" -ne 0 ]; then
	pass "jsonc/a-commented-config-is-refused-not-mangled"
else
	fail "jsonc/a-commented-config-is-refused-not-mangled" "the installer rewrote a JSONC file"
fi
assert_equals "jsonc/the-commented-config-is-byte-identical" "$BEFORE6" "$(cat "$H6/.claude/settings.json")"

# ===========================================================================
printf -- '-- 6. Codex: its own file, same object, ambiguity reported --\n'
# ===========================================================================

H7="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H7/.codex"
cat >"$H7/.codex/config.toml" <<'EOF'
model = "gpt-5.6-sol"

[hooks.state]
"warp@codex-warp:stop:0:0" = { trusted_hash = "abc123" }
"warp@codex-warp:session_start:0:0" = { trusted_hash = "def456" }
EOF
TOML_BEFORE="$(cat "$H7/.codex/config.toml")"

bash "$INSTALL" install codex "$H7/.codex" >/dev/null 2>"$WORK_DIR/e7"
RC7=$?
assert_equals "codex/install-succeeds" "0" "$RC7"
assert_equals "codex/the-gate-is-registered-once" "1" "$(gate_count "$H7/.codex/hooks.json")"

# The third-party TOML table is not ours to touch — we register in hooks.json.
assert_equals "codex/the-third-party-toml-is-byte-identical" "$TOML_BEFORE" "$(cat "$H7/.codex/config.toml")"

bash "$INSTALL" install codex "$H7/.codex" >/dev/null 2>&1
assert_equals "codex/a-second-run-adds-no-duplicate" "1" "$(gate_count "$H7/.codex/hooks.json")"

# F2 from the spike: with BOTH a hooks.json and an inline [hooks] table, Codex
# itself warns that it is loading from two places. The installer should surface
# that rather than leave the operator to discover it in a log.
H8="$(mktemp -d "$WORK_DIR/home.XXXXXX")"
mkdir -p "$H8/.codex"
cat >"$H8/.codex/config.toml" <<'EOF'
[hooks]
[[hooks.Stop]]
command = "/opt/something/else.sh"
EOF
bash "$INSTALL" install codex "$H8/.codex" >/dev/null 2>"$WORK_DIR/e8"
if grep -qi 'both\|ambig\|config.toml' "$WORK_DIR/e8" 2>/dev/null; then
	pass "codex/a-dual-representation-is-reported"
else
	fail "codex/a-dual-representation-is-reported" \
		"an inline [hooks] table beside hooks.json was not surfaced (stderr=[$(cat "$WORK_DIR/e8")])"
fi

# ===========================================================================
printf -- '-- 7. Error propagation: an unwritable target changes nothing --\n'
# ===========================================================================

H9="$(new_home)"
S9="$H9/.claude/settings.json"
BEFORE9="$(cat "$S9")"
chmod a-w "$H9/.claude"

if [ -w "$H9/.claude" ]; then
	pass "errprop/an-unwritable-target-is-refused (skipped: running as root)"
	pass "errprop/the-existing-config-is-untouched (skipped: running as root)"
else
	bash "$INSTALL" install claude "$H9" >/dev/null 2>"$WORK_DIR/e9"
	RC9=$?
	if [ "$RC9" -ne 0 ]; then
		pass "errprop/an-unwritable-target-is-refused"
	else
		fail "errprop/an-unwritable-target-is-refused" "reported success against an unwritable directory"
	fi
	assert_equals "errprop/the-existing-config-is-untouched" "$BEFORE9" "$(cat "$S9")"
fi
chmod u+w "$H9/.claude"

# ===========================================================================
printf -- '-- 8. Non-vacuity: the preservation assertions are real --\n'
# ===========================================================================
#
# Every "survives" assertion above passes trivially if the installer never
# writes anything at all. So: prove it DID write, by showing the file changed
# and the gate appeared where it was previously absent.

H10="$(new_home)"
S10="$H10/.claude/settings.json"
BEFORE10="$(cat "$S10")"
assert_equals "nonvacuous/the-gate-was-absent-before" "0" "$(gate_count "$S10")"
bash "$INSTALL" install claude "$H10" >/dev/null 2>&1
if [ "$BEFORE10" = "$(cat "$S10")" ]; then
	fail "nonvacuous/the-installer-actually-modified-the-file" \
		"the file is unchanged — every preservation assertion above is vacuous"
else
	pass "nonvacuous/the-installer-actually-modified-the-file"
fi
assert_equals "nonvacuous/the-gate-is-present-after" "1" "$(gate_count "$S10")"

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
