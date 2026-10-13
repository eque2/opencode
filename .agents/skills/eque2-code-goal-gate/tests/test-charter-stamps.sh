#!/usr/bin/env bash
# test-charter-stamps.sh — the emitted charter's acceptance-contract stamps
# (T4.2).
#
# Two properties, and the second is the one that rots quietly:
#
#   1. The checklist is emitted to its OWN file and LINKED from the charter,
#      never restated inside it. Two copies drift, and a drifted acceptance
#      contract means the charter says one thing and the gate enforces another.
#   2. No stamp still tells the reader to drive a charter with a host agent's
#      built-in goal command. That instruction reads as harmless prose and
#      routes the reader into a mechanism that judges a conversation rather
#      than an evidenced checklist.
#
# The drift check is EXECUTED, not asserted: a fixture charter that disagrees
# with its criteria file must be reported by the same resolver the gate uses.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REFS="${TEST_DIR}/../../eque2-code-prepare-goal/references"
STAMPS="${REFS}/emitted-charter.md"
PARSE="${TEST_DIR}/../parse-acs.sh"
CHARTER_CHECK="${TEST_DIR}/../charter-check.sh"

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

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}

# --------------------------------------------------------------------------
# 1. Happy path — the checklist has its own file, and the charter links it
# --------------------------------------------------------------------------

assert_states "stamps/criteria-emitted-to-own-file" "$STAMPS" 'ACs\.md'
assert_states "stamps/charter-links-relatively" "$STAMPS" '\./ACs\.md'
assert_states "stamps/charter-does-not-restate" "$STAMPS" 'never a second copy|does not restate'
assert_states "stamps/evidence-line-required" "$STAMPS" 'evidence:'
assert_states "stamps/explanation-line-required" "$STAMPS" 'explanation:'

# The reversal must be stated as BOTH halves, so a later reader cannot revert
# the format on the strength of the mechanism having reverted.
assert_states "stamps/states-mechanism-half" "$STAMPS" 'stop hook'
assert_states "stamps/states-format-half" "$STAMPS" 'natural-language markdown checkboxes|markdown checkboxes'

# The mandatory items MOVED into ACs.md — they were not dropped.
assert_states "stamps/quality-gate-item-kept" "$STAMPS" 'quality gate passes end-to-end'
assert_states "stamps/verdict-item-kept" "$STAMPS" 'binding verdict is recorded'
assert_states "stamps/canary-item-kept" "$STAMPS" 'canary'

# --------------------------------------------------------------------------
# 2. State transition — NO stamp drives the charter with a built-in goal command
# --------------------------------------------------------------------------

assert_states "transition/names-pursue-goal" "$STAMPS" 'pursue-goal'

# The predecessor instruction, in the shapes it actually took.
OFFENDERS=0
while IFS= read -r line; do
	case "$line" in
	*'`/goal '*|*'/goal <condition>'*|*'paste the one-line condition into'*)
		OFFENDERS=$((OFFENDERS + 1))
		printf '        offending line: %s\n' "$line"
		;;
	esac
done <"$STAMPS"
assert_equals "transition/no-builtin-goal-command-instruction" "0" "$OFFENDERS"

# And the same sweep across every reference the skill ships. SCANNED is
# asserted too: with no nullglob, a renamed references/ leaves the literal glob,
# the [ -f ] test skips it, and a sweep that examined NOTHING reports zero
# offenders — a green test proving only that it ran.
OFFENDERS=0
SCANNED=0
for f in "$REFS"/*.md "${TEST_DIR}/../../eque2-code-prepare-goal/SKILL.md"; do
	[ -f "$f" ] || continue
	SCANNED=$((SCANNED + 1))
	base="$(basename -- "$f")"
	while IFS= read -r line; do
		case "$line" in
		*'`/goal '*|*'/goal <condition>'*)
			OFFENDERS=$((OFFENDERS + 1))
			printf '        %s: %s\n' "$base" "$line"
			;;
		esac
	done <"$f"
done
assert_equals "transition/no-references-still-instruct-it" "0" "$OFFENDERS"
if [ "$SCANNED" -ge 5 ]; then
	pass "transition/sweep-actually-scanned-files ($SCANNED)"
else
	fail "transition/sweep-actually-scanned-files" "only $SCANNED file(s) scanned — the sweep found nothing to examine, so its zero proves nothing"
fi

# --------------------------------------------------------------------------
# 3. Drift — a charter disagreeing with its criteria file is REPORTED
#
# This section previously compared a count the TEST wrote against a count the
# TEST extracted, with no goal-gate code involved: it passed whether or not any
# drift detection existed. charter-check.sh is the implementation it should
# always have been driving, and every assertion below now runs it.
# --------------------------------------------------------------------------

G="$WORK_DIR/X.goal"
mkdir -p -- "$G"
cat >"$G/ACs.md" <<'EOF'
# Done when

- [ ] The first thing works — `run.sh`
      - explanation: not built yet.
- [ ] The second thing works — `run.sh`
      - explanation: not built yet.
EOF

# The parser is the single source of count truth; charter-check delegates to it
# rather than counting a second time.
COUNT="$(bash "$PARSE" "$G/ACs.md" 2>/dev/null | sed -n 's/^total=//p')"
assert_equals "drift/parser-counts-the-file" "2" "$COUNT"

# Agreement is clean.
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf '# Charter\n\n## Done when\n\nThe acceptance contract is [`./ACs.md`](./ACs.md) (2 criteria).\n' >"$G/goal.md"
RUN_OUT="$(bash "$CHARTER_CHECK" "$G" 2>&1)"
RUN_RC=$?
assert_equals "drift/agreement-is-clean" "0" "$RUN_RC"

# A disagreeing count is reported, and the report names both numbers.
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf '# Charter\n\n## Done when\n\nThe acceptance contract is [`./ACs.md`](./ACs.md) (3 criteria).\n' >"$G/goal.md"
RUN_OUT="$(bash "$CHARTER_CHECK" "$G" 2>&1)"
RUN_RC=$?
assert_equals "drift/disagreement-is-reported" "4" "$RUN_RC"
case "$RUN_OUT" in
*"claims 3 criteria"*"holds 2"*) pass "drift/report-names-both-counts" ;;
*) fail "drift/report-names-both-counts" "the report does not name both counts: [$RUN_OUT]" ;;
esac

# A charter that RESTATES the checklist is drift — that is the second copy the
# whole arrangement exists to prevent.
cat >"$G/goal.md" <<'EOF'
# Charter

## Done when

The acceptance contract is [`./ACs.md`](./ACs.md) (2 criteria).

- [ ] The first thing works
- [ ] The second thing works
EOF
RUN_OUT="$(bash "$CHARTER_CHECK" "$G" 2>&1)"
RUN_RC=$?
assert_equals "drift/restated-checklist-reported" "4" "$RUN_RC"
case "$RUN_OUT" in
*restates*) pass "drift/restatement-explains-itself" ;;
*) fail "drift/restatement-explains-itself" "the report does not name restatement: [$RUN_OUT]" ;;
esac

# A charter that does not link its contract relatively cannot move as a unit.
printf '# Charter\n\nSee /Users/somebody/elsewhere/ACs.md\n' >"$G/goal.md"
RUN_OUT="$(bash "$CHARTER_CHECK" "$G" 2>&1)"
RUN_RC=$?
assert_equals "drift/absolute-link-reported" "4" "$RUN_RC"

# An UNPARSEABLE criteria file makes agreement unknown — reported, never
# assumed to be agreement.
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf '# Charter\n\n[`./ACs.md`](./ACs.md)\n' >"$G/goal.md"
printf '# Done when\n\nNothing here is a criterion.\n' >"$G/ACs.md"
RUN_OUT="$(bash "$CHARTER_CHECK" "$G" 2>&1)"
RUN_RC=$?
assert_equals "drift/unparseable-is-unknown-not-agreement" "3" "$RUN_RC"
case "$RUN_OUT" in
*UNKNOWN*) pass "drift/unknown-is-reported-as-unknown" ;;
*) fail "drift/unknown-is-reported-as-unknown" "an unknown was not reported as one: [$RUN_OUT]" ;;
esac

# Not a prepared folder at all.
RUN_OUT="$(bash "$CHARTER_CHECK" "$WORK_DIR" 2>&1)"
assert_equals "drift/not-a-goal-folder-refused" "2" "$?"

# --------------------------------------------------------------------------
# 4. Boundary and Empty/Null
# --------------------------------------------------------------------------

# shellcheck disable=SC2016  # a literal sed pattern, not an expansion
printf '# Done when\n\n- [ ] The only thing works — `run.sh`\n      - explanation: not yet.\n' >"$G/ACs.md"
assert_equals "boundary/single-criterion-valid" "1" \
	"$(bash "$PARSE" "$G/ACs.md" 2>/dev/null | sed -n 's/^total=//p')"

printf '# Done when\n\nNothing here is a criterion.\n' >"$G/ACs.md"
bash "$PARSE" "$G/ACs.md" >/dev/null 2>&1
assert_equals "empty/no-criteria-is-invalid" "2" "$?"

: >"$G/ACs.md"
bash "$PARSE" "$G/ACs.md" >/dev/null 2>&1
assert_equals "empty/empty-file-is-invalid" "2" "$?"

# --------------------------------------------------------------------------
# 6. Blocked criteria — a charter must not drift once a third state exists
# --------------------------------------------------------------------------

BG="$WORK_DIR/Blocked.goal"
mkdir -p "$BG"
cat >"$BG/ACs.md" <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials this run cannot mint.
- [ ] Outstanding — `scripts/c.sh`
      - explanation: not started.
EOF

# Happy path: stated counts match a checklist that contains a blocked criterion.
cat >"$BG/goal.md" <<'EOF'
# Blocked charter

The acceptance contract is [`./ACs.md`](./ACs.md) (3 criteria), of which (1 blocked).
EOF
RUN_OUT="$(bash "$CHARTER_CHECK" "$BG" 2>&1)"
assert_equals "blocked/agreeing-charter-passes" "0" "$?"
case "$RUN_OUT" in
*'(1 blocked)'*) pass "blocked/success-line-reports-the-blocked-count" ;;
*) fail "blocked/success-line-reports-the-blocked-count" "got [$RUN_OUT]" ;;
esac

# Invalid input: a stated blocked count that contradicts the checklist.
cat >"$BG/goal.md" <<'EOF'
# Blocked charter

The acceptance contract is [`./ACs.md`](./ACs.md) (3 criteria), of which (2 blocked).
EOF
RUN_OUT="$(bash "$CHARTER_CHECK" "$BG" 2>&1)"
assert_equals "blocked/contradicting-blocked-count-is-drift" "4" "$?"
case "$RUN_OUT" in
*'claims 2 blocked'*) pass "blocked/drift-names-both-numbers" ;;
*) fail "blocked/drift-names-both-numbers" "got [$RUN_OUT]" ;;
esac

# A restated BLOCKED checkbox is drift, exactly as a restated `[ ]` or `[x]` is.
# Without `!` in the class this is the one state that could be copied into a
# charter and never reported.
cat >"$BG/goal.md" <<'EOF'
# Blocked charter

The acceptance contract is [`./ACs.md`](./ACs.md) (3 criteria).

- [!] Cannot be done — `scripts/b.sh`
EOF
RUN_OUT="$(bash "$CHARTER_CHECK" "$BG" 2>&1)"
assert_equals "blocked/restated-blocked-checkbox-is-drift" "4" "$?"
case "$RUN_OUT" in
*'restates 1 checkbox'*) pass "blocked/restated-blocked-box-is-counted" ;;
*) fail "blocked/restated-blocked-box-is-counted" "got [$RUN_OUT]" ;;
esac

# Boundary: an unparseable checklist is UNKNOWN (exit 3) — a finding, not a pass.
cat >"$BG/goal.md" <<'EOF'
# Blocked charter

The acceptance contract is [`./ACs.md`](./ACs.md).
EOF
printf 'A stray [!] line that is not a criterion.\n' >"$BG/ACs.md"
bash "$CHARTER_CHECK" "$BG" >/dev/null 2>&1
assert_equals "blocked/unparseable-checklist-is-unknown" "3" "$?"

# Empty/null: with zero blocked, behaviour and output are identical to before.
cat >"$BG/ACs.md" <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
EOF
RUN_OUT="$(bash "$CHARTER_CHECK" "$BG" 2>&1)"
assert_equals "blocked/zero-blocked-still-passes" "0" "$?"
case "$RUN_OUT" in
*blocked*) fail "blocked/zero-blocked-output-unchanged" "success line mentions blocked: [$RUN_OUT]" ;;
*) pass "blocked/zero-blocked-output-unchanged" ;;
esac

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
