#!/usr/bin/env bash
# test-legacy-charter.sh — charters written under the old scheme stay readable
# (T5.2).
#
# There is NO requirement to auto-migrate. The requirement is that nothing
# BREAKS: a charter produced before the acceptance contract moved into its own
# file must still open, and its criteria must still be findable by a human.
#
# The failure this guards against is a silent one. A tool that cannot read a v1
# charter and says nothing has not "handled" it — it has hidden it. So every
# unreadable shape here must be REPORTED, and in particular an inline-only
# charter must never be mistaken for a folder with zero criteria, which is the
# vacuous-truth trap wearing a migration costume.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PARSE="${TEST_DIR}/../parse-acs.sh"
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

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

export GOAL_GATE_SKIP_REGISTRATION_CHECK=1

# A v1 charter: one document, criteria inline under a "Done when" heading, no
# sibling ACs.md, no evidence/explanation lines. This is the real shape the
# previous skill version emitted.
V1_CHARTER='# Charter — legacy workstream

**Written:** 2026-01-04

## Scope

Harden the ingest path.

## Done when (verification checklist — completion contract)

- [ ] The codebase quality gate passes end-to-end — lint, type-check, tests
- [x] The ingest path handles an empty batch without raising
- [ ] The binding verdict is recorded in STATE.md

## Build via

Run the spec pipeline, then the build loop.
'

# --------------------------------------------------------------------------
# 1. Happy path — a v1 charter opens, and its criteria are discoverable
# --------------------------------------------------------------------------

L="$WORK_DIR/legacy"
mkdir -p -- "$L"
printf '%s' "$V1_CHARTER" >"$L/goal.md"

# NOTE — the fixture's own shape (that the file exists, has a Done-when heading,
# and holds three checkbox lines) is a precondition of this suite, not a test of
# goal-gate: greps against a string this file defined would pass with the whole
# goal-gate directory deleted. They are asserted ONCE, here, as a fixture guard,
# and every real assertion below runs goal-gate code.
if [ -s "$L/goal.md" ] && grep -q "## Done when" "$L/goal.md" &&
	[ "$(grep -cE '^- \[[ xX]\]' "$L/goal.md")" = "3" ]; then
	pass "fixture/v1-charter-is-well-formed"
else
	fail "fixture/v1-charter-is-well-formed" "the v1 fixture is not what the rest of this suite assumes"
fi

# The parser reads them where they are. A v1 charter is a perfectly valid
# criteria FILE — it simply is not a goal FOLDER.
PARSED="$(bash "$PARSE" "$L/goal.md" 2>/dev/null | sed -n 's/^total=//p')"
assert_equals "v1/parser-reads-inline-criteria" "3" "$PARSED"

CHECKED="$(bash "$PARSE" "$L/goal.md" 2>/dev/null | sed -n 's/^checked=//p')"
assert_equals "v1/parser-counts-the-ticked-one" "1" "$CHECKED"

# The v1 tick carries no evidence line, so the verdict is NOT done. That is
# correct and is not a regression: it is the evidence rule applied to old
# content, and it fails CLOSED.
bash "$PARSE" "$L/goal.md" >/dev/null 2>&1
assert_equals "v1/verdict-is-not-done" "1" "$?"

# --------------------------------------------------------------------------
# 2. Invalid input — an inline-only charter is REPORTED, not silently accepted
# --------------------------------------------------------------------------

# `pursue-goal` must refuse a v1 folder rather than treat a missing ACs.md as
# an empty checklist. Naming what is missing is what makes the refusal useful.
OUT="$(GOAL_GATE_ANCHOR="$WORK_DIR" bash "$STARTER" "$L" 2>&1)"
RC=$?
assert_equals "inline/refused-not-misread" "2" "$RC"
case "$OUT" in
*ACs.md*) pass "inline/refusal-names-what-is-missing" ;;
*) fail "inline/refusal-names-what-is-missing" "the refusal does not say ACs.md is missing: [$OUT]" ;;
esac
if [ -d "$WORK_DIR/.goal-gate" ]; then
	fail "inline/no-loop-state-written" "a loop was started against a legacy charter"
else
	pass "inline/no-loop-state-written"
fi

# The upgrade path is not automatic, but it IS available: copying the section
# into a sibling ACs.md makes the same charter runnable, with nothing lost.
sed -n '/^## Done when/,/^## Build via/p' "$L/goal.md" | grep -E '^- \[[ xX]\]|^# ' >"$L/ACs.md"
# The assertion that matters is the PARSER's, not a second grep of our own
# extraction: it is what proves the moved criteria are readable by the gate.
assert_equals "upgrade/parser-reads-the-moved-criteria" "3" \
	"$(bash "$PARSE" "$L/ACs.md" 2>/dev/null | sed -n 's/^total=//p')"
assert_equals "upgrade/moved-tick-count-preserved" "1" \
	"$(bash "$PARSE" "$L/ACs.md" 2>/dev/null | sed -n 's/^checked=//p')"

# --------------------------------------------------------------------------
# 3. Boundary — a half-migrated charter
# --------------------------------------------------------------------------

# Both an inline section AND a sibling ACs.md, disagreeing. Nothing may silently
# pick a winner: the disagreement is the finding.
H="$WORK_DIR/half"
mkdir -p -- "$H"
printf '%s' "$V1_CHARTER" >"$H/goal.md"
cat >"$H/ACs.md" <<'EOF'
# Done when

- [ ] The ingest path handles an empty batch without raising
      - explanation: not verified yet.
EOF

INLINE="$(grep -cE '^- \[[ xX]\]' "$H/goal.md")"
FILED="$(bash "$PARSE" "$H/ACs.md" 2>/dev/null | sed -n 's/^total=//p')"
if [ "$INLINE" != "$FILED" ]; then
	pass "half/disagreement-is-detectable"
else
	fail "half/disagreement-is-detectable" "inline [$INLINE] and filed [$FILED] agree; the fixture is wrong"
fi

# The gate reads ACs.md — the filed contract — so a half-migrated folder RUNS,
# and runs against the filed criteria. It does not silently merge the two.
OUT="$(GOAL_GATE_ANCHOR="$H" bash "$STARTER" "$H" 2>&1)"
RC=$?
assert_equals "half/runs-against-the-filed-contract" "0" "$RC"
case "$OUT" in
*"$H/ACs.md"*) pass "half/binds-the-filed-file" ;;
*) fail "half/binds-the-filed-file" "the binding does not name ACs.md: [$OUT]" ;;
esac

# The stale inline copy is left exactly as it was — nothing is rewritten.
assert_equals "half/inline-copy-untouched" "3" "$(grep -cE '^- \[[ xX]\]' "$H/goal.md")"

# --------------------------------------------------------------------------
# 4. Empty/Null — a charter with no criteria section
# --------------------------------------------------------------------------

N="$WORK_DIR/nocriteria"
mkdir -p -- "$N"
printf '# Charter\n\n## Scope\n\nSomething.\n' >"$N/goal.md"

bash "$PARSE" "$N/goal.md" >/dev/null 2>&1
assert_equals "empty/no-criteria-is-an-error" "2" "$?"

printf '# Done when\n\nNothing here.\n' >"$N/ACs.md"
OUT="$(GOAL_GATE_ANCHOR="$N" bash "$STARTER" "$N" 2>&1)"
RC=$?
assert_equals "empty/zero-criteria-refused-not-completed" "2" "$RC"
case "$OUT" in
*"no criteria"*) pass "empty/refusal-explains-itself" ;;
*) fail "empty/refusal-explains-itself" "no explanation for a criteria-less charter: [$OUT]" ;;
esac

# An entirely empty charter file.
E="$WORK_DIR/emptyfile"
mkdir -p -- "$E"
: >"$E/goal.md"
: >"$E/ACs.md"
OUT="$(GOAL_GATE_ANCHOR="$E" bash "$STARTER" "$E" 2>&1)"
assert_equals "empty/empty-charter-refused" "2" "$?"

# --------------------------------------------------------------------------
# 5. The compatibility position is written down, not merely implemented
# --------------------------------------------------------------------------

# The compatibility POSITION — no auto-migration, and what a reader with a v1
# charter should do — must be written down, not merely implemented. A grep for
# `ACs.md` proved only that the current layout is mentioned somewhere.
ANTI="${TEST_DIR}/../../eque2-code-prepare-goal/references/anti-patterns.md"
CONTRACT="${TEST_DIR}/../../eque2-code-prepare-goal/references/goal-folder.md"
for pair in "$ANTI:Restating the checklist" "$CONTRACT:ACs\.md"; do
	doc="${pair%%:*}"
	pat="${pair#*:}"
	if grep -Eq -- "$pat" "$doc" 2>/dev/null; then
		pass "docs/$(basename -- "$doc" .md)-states-the-layout"
	else
		fail "docs/$(basename -- "$doc" .md)-states-the-layout" "$doc does not state: $pat"
	fi
done

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
