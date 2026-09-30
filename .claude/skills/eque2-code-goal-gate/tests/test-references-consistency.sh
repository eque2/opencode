#!/usr/bin/env bash
# test-references-consistency.sh — the reference documents describe the CURRENT
# mechanism, and the health surface is DEMONSTRATED rather than claimed (T4.3).
#
# Reference prose rots silently. Nothing breaks when a document still describes
# the predecessor's loop or the old layout — it just quietly teaches the next
# reader something untrue, and a reader who acts on it reverts working code.
#
# The health surface (S32) is the other half. "You can answer 'is this loop
# healthy?' in under a minute" is a TIMING claim, so this suite runs the surface
# and times it instead of restating the claim.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REFS="${TEST_DIR}/../../eque2-code-prepare-goal/references"
SKILL="${TEST_DIR}/../../eque2-code-prepare-goal/SKILL.md"
CANCEL="${TEST_DIR}/../cancel.sh"
STARTER="${TEST_DIR}/../pursue-goal.sh"

PASS_COUNT=0
FAIL_COUNT=0
WORK_DIR=""

cleanup() {
	if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
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

assert_states() {
	local name="$1" file="$2" pattern="$3"
	if [ ! -f "$file" ]; then
		fail "$name" "no such document: $file"
		return
	fi
	if grep -Eqi -- "$pattern" "$file"; then
		pass "$name"
	else
		fail "$name" "$(basename -- "$file") does not state: $pattern"
	fi
}

# --------------------------------------------------------------------------
# 1. Happy path — the anti-pattern states the ACTUAL rule, both halves
# --------------------------------------------------------------------------

AP="$REFS/anti-patterns.md"

assert_states "antipattern/names-the-acs-file" "$AP" 'ACs\.md'
assert_states "antipattern/criteria-are-checkboxes" "$AP" 'markdown checkboxes'
assert_states "antipattern/rejects-the-old-schema" "$AP" 'type: script|check:'

# Both halves in one place. A document that states only the mechanism invites
# a reader to "finish the job" by reverting the format too.
assert_states "antipattern/states-mechanism-half" "$AP" 'stop hook'
assert_states "antipattern/warns-against-half-reverting" "$AP" 'Reverting the mechanism does not license|read together'

assert_states "antipattern/forbids-restating-in-charter" "$AP" 'Restating the checklist'
assert_states "antipattern/forbids-builtin-goal-command" "$AP" "built-in goal command"

# --------------------------------------------------------------------------
# 2. Agent mapping — one mechanism, two registrations, and the trust caveat
# --------------------------------------------------------------------------

AM="$REFS/agent-mapping.md"

assert_states "mapping/drive-row-names-pursue-goal" "$AM" 'pursue-goal'
assert_states "mapping/one-mechanism-two-registrations" "$AM" 'TWO registrations|two registrations'
assert_states "mapping/names-claude-location" "$AM" 'settings\.json'
assert_states "mapping/names-codex-location" "$AM" 'hooks\.json'
assert_states "mapping/records-the-trust-caveat" "$AM" 'TRUSTED|trusted'
assert_states "mapping/records-the-silent-skip" "$AM" 'skipped silently|silently skipped'

# Boundary: a reference naming one agent but not the other.
ONE_SIDED=0
SCANNED=0
for f in "$REFS"/*.md; do
	[ -f "$f" ] || continue
	SCANNED=$((SCANNED + 1))
	if grep -qi 'codex' "$f" && ! grep -qi 'claude' "$f"; then
		ONE_SIDED=$((ONE_SIDED + 1))
		printf '        names Codex but not Claude: %s\n' "$(basename -- "$f")"
	fi
done
assert_equals "mapping/no-one-sided-reference" "0" "$ONE_SIDED"
# Every negative sweep in this file counts what it SCANNED. With no nullglob a
# renamed references/ leaves the literal glob, `[ -f ]` skips it, and a sweep
# that examined nothing reports zero offenders — green, having checked nothing.
if [ "$SCANNED" -ge 5 ]; then
	pass "mapping/sweep-actually-scanned-files ($SCANNED)"
else
	fail "mapping/sweep-actually-scanned-files" "only $SCANNED reference(s) scanned; a zero from an empty sweep proves nothing"
fi

# --------------------------------------------------------------------------
# 3. Invalid input — no reference still describes the old loop or old layout
# --------------------------------------------------------------------------

STALE=0
STALE_SCANNED=0
for f in "$REFS"/*.md "$SKILL"; do
	[ -f "$f" ] || continue
	STALE_SCANNED=$((STALE_SCANNED + 1))
	base="$(basename -- "$f")"
	while IFS= read -r line; do
		case "$line" in
		# The predecessor by name, and the built-in goal command as an
		# instruction. `pursue-goal` and `/prepare-goal` must not match.
		*'jam-loop'*|*'`/goal '*|*'/goal <condition>'*)
			STALE=$((STALE + 1))
			printf '        %s: %s\n' "$base" "$line"
			;;
		esac
	done <"$f"
done
assert_equals "stale/no-predecessor-references" "0" "$STALE"
if [ "$STALE_SCANNED" -ge 5 ]; then
	pass "stale/sweep-actually-scanned-files ($STALE_SCANNED)"
else
	fail "stale/sweep-actually-scanned-files" "only $STALE_SCANNED file(s) scanned"
fi

# The old layout: artefacts beside the input rather than inside X.goal/.
assert_states "layout/folder-contract-is-current" "$REFS/goal-folder.md" 'X\.goal'
assert_states "layout/skill-names-the-folder" "$SKILL" 'X\.goal'

# Empty/Null: an empty reference file is a defect, not a neutral file.
EMPTIES=0
EMPTY_SCANNED=0
for f in "$REFS"/*.md; do
	[ -f "$f" ] || continue
	EMPTY_SCANNED=$((EMPTY_SCANNED + 1))
	if [ ! -s "$f" ]; then
		EMPTIES=$((EMPTIES + 1))
		printf '        empty reference: %s\n' "$(basename -- "$f")"
	fi
done
assert_equals "empty/no-empty-reference-files" "0" "$EMPTIES"
if [ "$EMPTY_SCANNED" -ge 5 ]; then
	pass "empty/sweep-actually-scanned-files ($EMPTY_SCANNED)"
else
	fail "empty/sweep-actually-scanned-files" "only $EMPTY_SCANNED reference(s) scanned"
fi

# Every reference the skill routes to must exist.
MISSING=0
ROUTES=0
while IFS= read -r ref; do
	[ -n "$ref" ] || continue
	ROUTES=$((ROUTES + 1))
	if [ ! -f "${TEST_DIR}/../../eque2-code-prepare-goal/$ref" ]; then
		MISSING=$((MISSING + 1))
		printf '        routed but absent: %s\n' "$ref"
	fi
done < <(grep -oE 'references/[a-z-]+\.md' "$SKILL" | LC_ALL=C sort -u)
assert_equals "routing/every-referenced-file-exists" "0" "$MISSING"
if [ "$ROUTES" -ge 3 ]; then
	pass "routing/routes-were-actually-found ($ROUTES)"
else
	fail "routing/routes-were-actually-found" "only $ROUTES route(s) extracted; a missing SKILL.md would also yield zero"
fi

# --------------------------------------------------------------------------
# 4. Timing — the health surface is DEMONSTRATED, not asserted (S32)
# --------------------------------------------------------------------------

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

A="$WORK_DIR/tree"
G="$A/X.goal"
mkdir -p -- "$G"
printf '# charter\n' >"$G/goal.md"
cat >"$G/ACs.md" <<'EOF'
# Done when

- [ ] The thing works — `run.sh`
      - explanation: not built yet.
- [ ] The other thing works — `run.sh`
      - explanation: not built yet.
EOF

GOAL_GATE_SKIP_REGISTRATION_CHECK=1 GOAL_GATE_ANCHOR="$A" bash "$STARTER" "$G" >/dev/null 2>&1

# A run log with a history to read, so the surface has something to summarise.
cat >"$G/run-log.jsonl" <<'EOF'
{"iteration":1,"decision":"refused","unchecked":2}
{"iteration":2,"decision":"refused","unchecked":2}
{"iteration":3,"decision":"refused","unchecked":1}
EOF

START="$(date +%s)"
HEALTH="$(cd "$A" && bash "$CANCEL" status "$A" 2>&1)"
HRC=$?
ELAPSED=$(($(date +%s) - START))

assert_equals "health/surface-answers" "0" "$HRC"

if [ "$ELAPSED" -le 60 ]; then
	pass "health/answers-within-60-seconds (${ELAPSED}s)"
else
	fail "health/answers-within-60-seconds" "took ${ELAPSED}s — S32 claims under a minute"
fi

# What a health answer has to contain to BE one: what is running, how far in,
# what is outstanding, and whether it is making progress.
for token in "workstream" "iteration" "outstanding" "run log"; do
	case "$HEALTH" in
	*"$token"*) pass "health/reports-$(printf '%s' "$token" | tr ' ' '-')" ;;
	*) fail "health/reports-$(printf '%s' "$token" | tr ' ' '-')" "the health answer omits '$token': [$HEALTH]" ;;
	esac
done

# The recent-decision trail is what separates "grinding" from "progressing".
case "$HEALTH" in
*refused*) pass "health/shows-recent-decisions" ;;
*) fail "health/shows-recent-decisions" "no decision history in the health answer: [$HEALTH]" ;;
esac

# Record the demonstration so the claim has evidence rather than a test name.
#
# This is a SIDE EFFECT, not an assertion. It used to be both: the test wrote
# the file with `|| true` swallowing any failure, then asserted the file was
# non-empty — and because the target is git-tracked, a stale committed copy kept
# it green even when the write failed outright. Asserting on an artefact the
# test just created, with the failure path muted, proves only that the assertion
# ran. What is actually worth checking is that THIS run's health output is a
# real answer, and that is what §4 above does.
EVIDENCE="${TEST_DIR}/../live-evidence/health-surface-demo.txt"
if {
	printf 'Health-surface demonstration (S32, T4.3)\n'
	printf 'Command: cancel.sh status\n'
	printf 'Elapsed: %ss (budget: 60s)\n\n' "$ELAPSED"
	printf '%s\n' "$HEALTH"
} >"$EVIDENCE" 2>/dev/null; then
	printf 'NOTE  demonstration recorded to %s\n' "$EVIDENCE"
else
	printf 'NOTE  could not record the demonstration to %s (not a test failure — the assertions above are the test)\n' "$EVIDENCE"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
