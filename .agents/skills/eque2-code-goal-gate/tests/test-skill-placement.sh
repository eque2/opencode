#!/usr/bin/env bash
# test-skill-placement.sh — suite for placing the skills into every installed
# agent's skill location (T3.7).
#
# The defect this guards is quiet: every skill file lived under `.claude/skills/`,
# which Codex does not read, so `pursue-goal` would be present on disk and
# undiscoverable under one of the two agents the feature claims to support —
# while both looked installed. Same shape as a drifted registration, one layer up.
#
# Every test runs against a FIXTURE home. Nothing here touches the real
# `$HOME/.claude`, `$HOME/.agents`, or `$CODEX_HOME`.
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

# A miniature source tree: same shape as the real checkout, a fraction of the
# bytes, so drift is provoked deliberately rather than by whatever happens to
# be in the repo.
SRC="$WORK_DIR/src"
for skill in eque2-code-prepare-goal eque2-code-pursue-goal eque2-code-goal-gate eque2-code-plan-goal eque2-code-agent-hannibal; do
	mkdir -p -- "$SRC/$skill/references"
	printf -- '---\nname: %s\n---\n\nbody\n' "$skill" >"$SRC/$skill/SKILL.md"
	printf 'reference\n' >"$SRC/$skill/references/notes.md"
done
# Something in the checkout that is NOT one of the three: it must not travel.
mkdir -p -- "$SRC/unrelated-skill"
printf 'unrelated\n' >"$SRC/unrelated-skill/SKILL.md"

export GOAL_GATE_SKILLS_SOURCE="$SRC"

RUN_OUT=""
RUN_RC=0
run() {
	RUN_OUT="$(bash "$INSTALL" "$@" 2>&1)"
	RUN_RC=$?
}

# skills_dir <agent> <home>
skills_dir() {
	bash "$INSTALL" skills-path "$1" "$2" 2>/dev/null
}

# --------------------------------------------------------------------------
# 1. Path resolution — the one real divergence between the agents
# --------------------------------------------------------------------------

H="$WORK_DIR/home1"
assert_equals "path/claude" "$H/.claude/skills" "$(skills_dir claude "$H")"
assert_equals "path/codex" "$H/.agents/skills" "$(skills_dir codex "$H")"
assert_equals "path/codex-config-home-normalized" "$H/.agents/skills" \
	"$(skills_dir codex "$H/.codex")"
assert_equals "path/codex-skills-ignore-custom-config-home" "$H/.agents/skills" \
	"$(HOME="$H" CODEX_HOME="$WORK_DIR/custom-codex-home" bash "$INSTALL" skills-path codex 2>/dev/null)"

run skills-path bogus "$H"
assert_equals "path/unknown-agent-rejected" "2" "$RUN_RC"

# Resolution creates NOTHING.
if [ -e "$H" ]; then
	fail "path/resolution-is-pure" "resolving a path created $H"
else
	pass "path/resolution-is-pure"
fi

# --------------------------------------------------------------------------
# 2. Happy path — both agents, discoverable under each
# --------------------------------------------------------------------------

for agent in claude codex; do
	run place-skills "$agent" "$H"
	if [ "$RUN_RC" -ne 0 ]; then
		fail "happy/$agent-placed" "exit $RUN_RC ([$RUN_OUT])"
		continue
	fi
	D="$(skills_dir "$agent" "$H")"
	MISSING=""
	for skill in eque2-code-prepare-goal eque2-code-pursue-goal eque2-code-goal-gate eque2-code-plan-goal eque2-code-agent-hannibal; do
		[ -f "$D/$skill/SKILL.md" ] || MISSING="$MISSING $skill"
	done
	if [ -n "$MISSING" ]; then
		fail "happy/$agent-placed" "not discoverable under $agent:$MISSING"
	else
		pass "happy/$agent-placed"
	fi
done

# The whole point of the task: pursue-goal is discoverable under CODEX.
if [ -f "$(skills_dir codex "$H")/eque2-code-pursue-goal/SKILL.md" ]; then
	pass "happy/pursue-goal-reaches-codex"
else
	fail "happy/pursue-goal-reaches-codex" "the starter is still Claude-only"
fi

# Subdirectories travel, and unrelated skills do not.
if [ -f "$(skills_dir codex "$H")/eque2-code-prepare-goal/references/notes.md" ]; then
	pass "happy/subdirectories-travel"
else
	fail "happy/subdirectories-travel" "references/ did not travel"
fi
if [ -e "$(skills_dir codex "$H")/unrelated-skill" ]; then
	fail "happy/only-named-skills-placed" "an unrelated skill was placed"
else
	pass "happy/only-named-skills-placed"
fi

# --------------------------------------------------------------------------
# 3. Empty/Null — an absent skills directory is created
# --------------------------------------------------------------------------

H2="$WORK_DIR/home2"
run place-skills claude "$H2"
if [ "$RUN_RC" -eq 0 ] && [ -d "$H2/.claude/skills/eque2-code-pursue-goal" ]; then
	pass "empty/absent-directory-created"
else
	fail "empty/absent-directory-created" "exit $RUN_RC ([$RUN_OUT])"
fi

# --------------------------------------------------------------------------
# 4. Boundary — a second run neither duplicates nor drifts
# --------------------------------------------------------------------------

BEFORE="$(find "$H2/.claude/skills" -type f | sort)"
run place-skills claude "$H2"
AFTER="$(find "$H2/.claude/skills" -type f | sort)"
if [ "$RUN_RC" -ne 0 ]; then
	fail "boundary/idempotent" "second run failed: exit $RUN_RC ([$RUN_OUT])"
elif [ "$BEFORE" != "$AFTER" ]; then
	fail "boundary/idempotent" "the file set changed on a second run"
else
	pass "boundary/idempotent"
fi
case "$RUN_OUT" in
*"already current"*) pass "boundary/reports-already-current" ;;
*) fail "boundary/reports-already-current" "no already-current report: [$RUN_OUT]" ;;
esac

# Boundary: exactly one agent placed — reported, and the other left alone.
H3="$WORK_DIR/home3"
run place-skills codex "$H3"
if [ "$RUN_RC" -eq 0 ] && [ -d "$H3/.agents/skills/eque2-code-pursue-goal" ] && [ ! -e "$H3/.claude" ]; then
	pass "boundary/single-agent-only"
else
	fail "boundary/single-agent-only" "exit $RUN_RC; the other agent's tree was touched or placement failed"
fi
case "$RUN_OUT" in
*"$H3/.agents/skills"*) pass "boundary/reports-where" ;;
*) fail "boundary/reports-where" "the report does not name the destination: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 5. Invalid input — a DRIFTED copy is reported, never silently overwritten
# --------------------------------------------------------------------------

DRIFTED="$H2/.claude/skills/eque2-code-pursue-goal/SKILL.md"
printf 'somebody edited this locally\n' >"$DRIFTED"

run place-skills claude "$H2"
if [ "$RUN_RC" -eq 0 ]; then
	fail "drift/reported-as-failure" "a drifted copy was accepted as success"
else
	pass "drift/reported-as-failure"
fi
case "$RUN_OUT" in
*DRIFTED*) pass "drift/report-names-the-cause" ;;
*) fail "drift/report-names-the-cause" "the report does not name drift: [$RUN_OUT]" ;;
esac
assert_equals "drift/local-edit-preserved" "somebody edited this locally" "$(cat "$DRIFTED")"

# --force is the deliberate override, and only then.
run place-skills claude "$H2" --force
if [ "$RUN_RC" -eq 0 ] && [ "$(cat "$DRIFTED")" != "somebody edited this locally" ]; then
	pass "drift/force-overwrites"
else
	fail "drift/force-overwrites" "exit $RUN_RC; the copy was not restored from source"
fi

# A non-directory occupying the destination name is reported, not clobbered.
H4="$WORK_DIR/home4"
mkdir -p -- "$H4/.claude/skills"
printf 'not a skill directory\n' >"$H4/.claude/skills/eque2-code-pursue-goal"
run place-skills claude "$H4"
if [ "$RUN_RC" -eq 0 ]; then
	fail "invalid/non-directory-reported" "a file in the destination name was accepted as success"
else
	pass "invalid/non-directory-reported"
fi
assert_equals "invalid/non-directory-untouched" "not a skill directory" "$(cat "$H4/.claude/skills/eque2-code-pursue-goal")"

# --------------------------------------------------------------------------
# 6. Error propagation — an unwritable skills directory
# --------------------------------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
	pass "error/unwritable-skipped-as-root"
	pass "error/missing-source-reported"
else
	H5="$WORK_DIR/home5"
	mkdir -p -- "$H5/.claude/skills"
	chmod 500 "$H5/.claude/skills"
	run place-skills claude "$H5"
	if [ "$RUN_RC" -eq 0 ]; then
		fail "error/unwritable-skipped-as-root" "an unwritable destination reported success"
	else
		pass "error/unwritable-skipped-as-root"
	fi
	chmod 700 "$H5/.claude/skills"

	# A source that does not exist is a reported failure, not an empty success.
	H6="$WORK_DIR/home6"
	RUN_OUT="$(GOAL_GATE_SKILLS_SOURCE="$WORK_DIR/no-such-source" bash "$INSTALL" place-skills claude "$H6" 2>&1)"
	RUN_RC=$?
	if [ "$RUN_RC" -eq 0 ]; then
		fail "error/missing-source-reported" "a missing source reported success"
	else
		pass "error/missing-source-reported"
	fi
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
