#!/usr/bin/env bash
# test-acs-format.sh — executable conformance suite for the ACs.md format
# contract (.claude/skills/prepare-goal/references/acs-format.md).
#
# Exercises the normative checker acs-format-check.sh across all required
# test-case classes: happy path, invalid input, boundary, empty/null, and state
# transitions — plus the load-bearing surrogate-substitution rule.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# CHECKER override (for the non-vacuity check only):
#   ACS_FORMAT_CHECKER=/path/to/mutant.sh bash test-acs-format.sh

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CHECKER="${ACS_FORMAT_CHECKER:-${TEST_DIR}/../acs-format-check.sh}"

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

# assert_valid <name> <checker args...>  — expects exit 0
assert_valid() {
	local name="$1"
	shift
	local out status
	out="$(bash "$CHECKER" "$@" 2>&1)"
	status=$?
	if [ "$status" -eq 0 ]; then
		pass "$name"
	else
		fail "$name" "expected exit 0, got $status ([$out])"
	fi
}

# assert_fails <name> <expected-exit> <checker args...>
#
# Requires the exact exit code AND an `acs-format:` diagnostic on stderr — a
# non-zero exit with no diagnostic is a silent failure path, which the coding
# standard forbids.
assert_fails() {
	local name="$1" expected="$2"
	shift 2
	local out status
	out="$(bash "$CHECKER" "$@" 2>&1)"
	status=$?
	if [ "$status" -eq 0 ]; then
		fail "$name" "expected failure (exit $expected) but succeeded with [$out]"
		return
	fi
	if [ "$status" -ne "$expected" ]; then
		fail "$name" "expected exit $expected, got $status ([$out])"
		return
	fi
	case "$out" in
	*acs-format:*) pass "$name" ;;
	*) fail "$name" "exit $status correct but no 'acs-format:' diagnostic: [$out]" ;;
	esac
}

# assert_count <name> <key> <expected> <checker args...>
assert_count() {
	local name="$1" key="$2" expected="$3"
	shift 3
	local out status actual
	out="$(bash "$CHECKER" "$@" 2>/dev/null)"
	status=$?
	if [ "$status" -ne 0 ]; then
		fail "$name" "expected exit 0, got $status"
		return
	fi
	actual="$(printf '%s\n' "$out" | sed -n "s/^${key}=//p")"
	assert_equals "$name" "$expected" "$actual"
}

# assert_reports <name> <expected-substring> <checker args...>
assert_reports() {
	local name="$1" needle="$2"
	shift 2
	local out
	out="$(bash "$CHECKER" "$@" 2>&1)"
	case "$out" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "diagnostic did not mention '$needle': [$out]" ;;
	esac
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

if [ ! -f "$CHECKER" ]; then
	printf 'FAIL  checker-present\n        no checker at %s\n' "$CHECKER"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "checker-present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/acs-format-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"

# --- A well-formed file: 3 criteria, 2 ticked, 2 critical, 1 critical unticked.
cat >"$ROOT/good.md" <<'EOF'
# Acceptance criteria

Goal: the gate never permits a stop on unfinished work.

## Done when

- [x] **CRITICAL** A zero-criteria file is rejected — `.claude/skills/goal-gate/acs-format-check.sh`
      - evidence: `bash acs-format-check.sh empty.md` → `acs-format: no criteria found` (exit 2)
      - at: 2026-07-19T14:02:11Z

- [x] The resolver returns a sibling folder — `.claude/skills/goal-gate/goal-folder-path.sh`
      - evidence: `bash test-goal-folder-contract.sh` → 26 passed, 0 failed

- [ ] **CRITICAL** The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not yet implemented; blocked on the run-all wiring task.

## Notes

Prose here is not a criterion.
EOF

: >"$ROOT/empty.md"
mkdir -p "$ROOT/adir"

# --------------------------------------------------------------------------
# 1. Happy path — a well-formed file yields total/checked/unchecked counts
# --------------------------------------------------------------------------

assert_valid "happy/well-formed-file-is-valid" "$ROOT/good.md"
assert_count "happy/total" total 3 "$ROOT/good.md"
assert_count "happy/checked" checked 2 "$ROOT/good.md"
assert_count "happy/unchecked" unchecked 1 "$ROOT/good.md"
assert_count "happy/critical" critical 2 "$ROOT/good.md"
assert_count "happy/critical-unchecked" critical_unchecked 1 "$ROOT/good.md"

# Prose, headings and blank lines are not criteria: the counts above already
# prove it (the file has 3 items among many lines), but assert the invariant
# that total = checked + unchecked explicitly.
good_total="$(bash "$CHECKER" "$ROOT/good.md" 2>/dev/null | sed -n 's/^total=//p')"
good_checked="$(bash "$CHECKER" "$ROOT/good.md" 2>/dev/null | sed -n 's/^checked=//p')"
good_unchecked="$(bash "$CHECKER" "$ROOT/good.md" 2>/dev/null | sed -n 's/^unchecked=//p')"
assert_equals "happy/total-equals-checked-plus-unchecked" \
	"$good_total" "$((good_checked + good_unchecked))"

# --------------------------------------------------------------------------
# 2. Invalid input — the load-bearing surrogate rule, and malformed syntax
# --------------------------------------------------------------------------

# A criterion phrased against a stand-in rather than the real entry point.
# This is the brief's quoted failure: it must fail the FORMAT, not pass a gate.
cat >"$ROOT/surrogate.md" <<'EOF'
- [x] The parser rejects an empty file — `tests/mock-parser.sh`
      - evidence: `bash tests/mock-parser.sh empty.md` → exit 2
EOF
assert_fails "invalid/surrogate-reference-rejected" 4 "$ROOT/surrogate.md"
assert_reports "invalid/surrogate-reference-named-as-such" "surrogate-reference" \
	"$ROOT/surrogate.md"

for word in stub fake dummy placeholder; do
	cat >"$ROOT/surrogate-$word.md" <<EOF
- [x] The gate refuses a stop — \`.claude/skills/goal-gate/${word}-runner.sh\`
      - evidence: \`bash ${word}-runner.sh\` → exit 1
EOF
	assert_fails "invalid/surrogate-$word-rejected" 4 "$ROOT/surrogate-$word.md"
done

# A criterion naming no specified system at all — prose names nothing verifiable.
cat >"$ROOT/no-reference.md" <<'EOF'
- [x] The parser rejects an empty file
      - evidence: it returned an error when I ran it
EOF
assert_fails "invalid/no-system-reference-rejected" 4 "$ROOT/no-reference.md"

# A bare backticked word with neither a separator nor an extension is not a
# path or entry point.
cat >"$ROOT/vague-reference.md" <<'EOF'
- [x] The parser rejects an empty file — `parser`
      - evidence: `parser empty.md` → exit 2
EOF
assert_fails "invalid/vague-reference-rejected" 4 "$ROOT/vague-reference.md"

# Malformed checkbox syntax.
cat >"$ROOT/bad-checkbox.md" <<'EOF'
- [X] Uppercase tick is not the contract — `.claude/skills/goal-gate/run-all.sh`
EOF
assert_fails "invalid/malformed-checkbox-uppercase" 4 "$ROOT/bad-checkbox.md"

cat >"$ROOT/bad-checkbox2.md" <<'EOF'
- [] No space between the brackets — `.claude/skills/goal-gate/run-all.sh`
EOF
assert_fails "invalid/malformed-checkbox-no-space" 4 "$ROOT/bad-checkbox2.md"

# The critical marker is a machine-read field, not emphasis: it is only valid
# immediately after the checkbox.
cat >"$ROOT/misplaced-critical.md" <<'EOF'
- [ ] The gate blocks, which is **CRITICAL** — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not implemented yet.
EOF
assert_fails "invalid/misplaced-critical-marker" 4 "$ROOT/misplaced-critical.md"

# Usage errors.
assert_fails "invalid/unknown-option" 64 --bogus "$ROOT/good.md"
assert_fails "invalid/too-many-arguments" 64 "$ROOT/good.md" "$ROOT/good.md"

# Input that is not a readable regular file.
assert_fails "invalid/missing-file" 3 "$ROOT/does-not-exist.md"
assert_fails "invalid/path-is-a-directory" 3 "$ROOT/adir"

# --------------------------------------------------------------------------
# 3. Boundary — exactly one criterion; a very long explanation
# --------------------------------------------------------------------------

cat >"$ROOT/single.md" <<'EOF'
- [x] The resolver rejects a reserved stem — `.claude/skills/goal-gate/goal-folder-path.sh`
      - evidence: `bash goal-folder-path.sh X.goal.md` → exit 2
EOF
assert_valid "boundary/exactly-one-criterion" "$ROOT/single.md"
assert_count "boundary/one-criterion-total" total 1 "$ROOT/single.md"
assert_count "boundary/one-criterion-checked" checked 1 "$ROOT/single.md"
assert_count "boundary/one-criterion-unchecked" unchecked 0 "$ROOT/single.md"

# A single UNticked criterion must not read as "nothing outstanding".
cat >"$ROOT/single-unticked.md" <<'EOF'
- [ ] The resolver rejects a reserved stem — `.claude/skills/goal-gate/goal-folder-path.sh`
      - explanation: the resolver does not exist yet.
EOF
assert_count "boundary/one-unticked-counts-as-outstanding" unchecked 1 \
	"$ROOT/single-unticked.md"

# A criterion with a very long explanation is valid — there is no length limit.
{
	# shellcheck disable=SC2016  # backticks are literal ACs.md markup, not a subshell
	printf -- '- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`\n'
	printf -- '      - explanation: '
	for _ in $(seq 1 400); do
		printf 'this criterion remains unmet for a long and carefully recorded reason. '
	done
	printf '\n'
} >"$ROOT/long-explanation.md"
assert_valid "boundary/very-long-explanation-accepted" "$ROOT/long-explanation.md"
assert_count "boundary/very-long-explanation-counted" unchecked 1 \
	"$ROOT/long-explanation.md"

# --------------------------------------------------------------------------
# 4. Empty / null — the vacuous-truth trap
# --------------------------------------------------------------------------

# ZERO CRITERIA IS AN ERROR, NEVER "ALL COMPLETE". This is the marquee case.
assert_fails "empty/empty-file-is-an-error" 2 "$ROOT/empty.md"
assert_reports "empty/empty-file-says-no-criteria" "no criteria found" "$ROOT/empty.md"

cat >"$ROOT/prose-only.md" <<'EOF'
# Acceptance criteria

Goal: everything works.

We are confident this is finished.
EOF
assert_fails "empty/prose-only-file-is-an-error" 2 "$ROOT/prose-only.md"

# A file whose only task items are INDENTED has zero criteria — it must not be
# read as a complete checklist.
cat >"$ROOT/indented-only.md" <<'EOF'
Examples, not criteria:

  - [x] An indented item is not a criterion — `.claude/skills/goal-gate/run-all.sh`
        - evidence: `bash run-all.sh` → exit 0
EOF
assert_fails "empty/indented-items-are-not-criteria" 2 "$ROOT/indented-only.md"

assert_fails "empty/empty-path-argument" 3 ""
assert_fails "empty/no-argument" 64

# The shipped template is invalid BY CONSTRUCTION: zero criteria.
TEMPLATE="${TEST_DIR}/../../eque2-code-prepare-goal/assets/ACs-template.md"
if [ -f "$TEMPLATE" ]; then
	pass "empty/template-present"
	assert_fails "empty/template-is-invalid-by-construction" 2 "$TEMPLATE"
else
	fail "empty/template-present" "no template at $TEMPLATE"
fi

# --------------------------------------------------------------------------
# 5. State transitions — unticked -> ticked, and ticked -> unticked
# --------------------------------------------------------------------------

# Start unticked, with an explanation. Valid.
cat >"$ROOT/state.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not yet implemented.
EOF
assert_valid "state/unticked-with-explanation-valid" "$ROOT/state.md"
assert_count "state/unticked-count" unchecked 1 "$ROOT/state.md"

# Transition unticked -> ticked WITHOUT swapping the field: the tick is refused.
# This is the single most important rule in the format.
cat >"$ROOT/state.md" <<'EOF'
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not yet implemented.
EOF
assert_fails "state/tick-keeping-explanation-refused" 4 "$ROOT/state.md"

# Transition unticked -> ticked with the field simply dropped: still refused.
cat >"$ROOT/state.md" <<'EOF'
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
EOF
assert_fails "state/tick-without-evidence-refused" 5 "$ROOT/state.md"
assert_reports "state/tick-without-evidence-named-as-such" "ticked-without-evidence" \
	"$ROOT/state.md"

# An EMPTY evidence value is not evidence.
cat >"$ROOT/state.md" <<'EOF'
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - evidence:
EOF
assert_fails "state/tick-with-empty-evidence-refused" 5 "$ROOT/state.md"

# The completed transition: ticked, with evidence. Valid.
cat >"$ROOT/state.md" <<'EOF'
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh fixtures/one-unticked.md` → `block` (exit 1)
      - at: 2026-07-19T15:00:00Z
EOF
assert_valid "state/ticked-with-evidence-valid" "$ROOT/state.md"
assert_count "state/ticked-count" checked 1 "$ROOT/state.md"
assert_count "state/ticked-leaves-none-unchecked" unchecked 0 "$ROOT/state.md"

# Transition ticked -> unticked KEEPING the evidence: refused. A reopened
# criterion must say why it is unmet, not point at a stale success.
cat >"$ROOT/state.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh fixtures/one-unticked.md` → `block` (exit 1)
EOF
assert_fails "state/untick-keeping-evidence-refused" 4 "$ROOT/state.md"

# Transition ticked -> unticked with NO field at all: refused as unexplained.
cat >"$ROOT/state.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
EOF
assert_fails "state/untick-without-explanation-refused" 6 "$ROOT/state.md"
assert_reports "state/untick-without-explanation-named-as-such" \
	"unticked-without-explanation" "$ROOT/state.md"

# An EMPTY explanation value is not an explanation.
cat >"$ROOT/state.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation:
EOF
assert_fails "state/untick-with-empty-explanation-refused" 6 "$ROOT/state.md"

# The completed reverse transition: unticked, with a written explanation.
cat >"$ROOT/state.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: regressed after the run-all rewrite; the exit code is now 0.
EOF
assert_valid "state/unticked-with-explanation-after-untick-valid" "$ROOT/state.md"

# --authoring relaxes the explanation rule ONLY.
cat >"$ROOT/fresh.md" <<'EOF'
- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
- [ ] The resolver returns a sibling folder — `.claude/skills/goal-gate/goal-folder-path.sh`
EOF
assert_fails "state/fresh-checklist-strict-by-default" 6 "$ROOT/fresh.md"
assert_valid "state/fresh-checklist-accepted-in-authoring-mode" --authoring "$ROOT/fresh.md"

# --authoring must NOT relax the evidence rule — a tick still needs evidence.
cat >"$ROOT/authoring-tick.md" <<'EOF'
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
EOF
assert_fails "state/authoring-does-not-relax-evidence" 5 --authoring "$ROOT/authoring-tick.md"

# --authoring must NOT relax the surrogate rule either.
assert_fails "state/authoring-does-not-relax-surrogate" 4 --authoring "$ROOT/surrogate.md"

# --authoring must NOT turn a zero-criteria file into a pass.
assert_fails "state/authoring-does-not-relax-zero-criteria" 2 --authoring "$ROOT/empty.md"

# --------------------------------------------------------------------------
# 6. A field line belonging to no criterion is an error
# --------------------------------------------------------------------------

cat >"$ROOT/orphan-field.md" <<'EOF'
Some prose.

      - evidence: `bash run-all.sh` → exit 0

- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh fixtures/one-unticked.md` → exit 1
EOF
assert_fails "orphan/evidence-without-criterion" 4 "$ROOT/orphan-field.md"

# --------------------------------------------------------------------------
# 7. Contract document exists and states the load-bearing rules
# --------------------------------------------------------------------------

CONTRACT="${TEST_DIR}/../../eque2-code-prepare-goal/references/acs-format.md"
if [ -f "$CONTRACT" ]; then
	pass "contract/document-present"
	for token in "ticked-without-evidence" "unticked-without-explanation" \
		"blocked-without-reason" "- \[!\] " \
		"CRITICAL" "surrogate" "specified system" "zero criteria"; do
		if grep -qi -- "$token" "$CONTRACT"; then
			pass "contract/states-$token"
		else
			fail "contract/states-$token" "contract does not mention '$token'"
		fi
	done
else
	fail "contract/document-present" "no contract at $CONTRACT"
fi

# --------------------------------------------------------------------------
# 8. The blocked state — `- [!] ` plus a mandatory `- blocked:` reason
#
# Blocked is neither met nor outstanding. This layer owns only whether it is
# WRITTEN correctly; parse-acs.sh owns the counting and validate-acs.sh the
# enforcement. What is pinned here is that a blocker must state a reason, that
# the reason is never relaxable, and that the fields of the three states do not
# mix — a criterion carrying fields from two states has not decided which state
# it is in.
# --------------------------------------------------------------------------

cat >"$ROOT/blocked-good.md" <<'EOF'
- [x] The resolver returns a sibling folder — `.claude/skills/goal-gate/goal-folder-path.sh`
      - evidence: `bash test-goal-folder-contract.sh` → 26 passed, 0 failed

- [!] **CRITICAL** The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials this run does not have and cannot mint.

- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not yet implemented.
EOF
assert_valid "blocked/well-formed-is-valid" "$ROOT/blocked-good.md"
assert_count "blocked/count" blocked 1 "$ROOT/blocked-good.md"
assert_count "blocked/total-includes-it" total 3 "$ROOT/blocked-good.md"
# Neither met nor outstanding: excluded from BOTH, which is the whole point.
assert_count "blocked/not-counted-as-checked" checked 1 "$ROOT/blocked-good.md"
assert_count "blocked/not-counted-as-unchecked" unchecked 1 "$ROOT/blocked-good.md"
# CRITICAL is legal on a blocked criterion and is reported, not rejected — but a
# blocked critical is not OUTSTANDING, so it is not in critical_unchecked.
assert_count "blocked/critical-marker-counted" critical 1 "$ROOT/blocked-good.md"
assert_count "blocked/critical-blocked-not-outstanding" critical_unchecked 0 "$ROOT/blocked-good.md"

# Data integrity: the three counts account for every criterion.
b_total="$(bash "$CHECKER" "$ROOT/blocked-good.md" 2>/dev/null | sed -n 's/^total=//p')"
b_checked="$(bash "$CHECKER" "$ROOT/blocked-good.md" 2>/dev/null | sed -n 's/^checked=//p')"
b_unchecked="$(bash "$CHECKER" "$ROOT/blocked-good.md" 2>/dev/null | sed -n 's/^unchecked=//p')"
b_blocked="$(bash "$CHECKER" "$ROOT/blocked-good.md" 2>/dev/null | sed -n 's/^blocked=//p')"
assert_equals "blocked/total-equals-checked-plus-unchecked-plus-blocked" \
	"$b_total" "$((b_checked + b_unchecked + b_blocked))"

# Backwards compatibility: a two-state file reports blocked=0, not nothing.
assert_count "blocked/absent-reports-zero" blocked 0 "$ROOT/good.md"

# --- The reason is mandatory (exit 8, distinct from 4, 5, 6 and 7) ---------
cat >"$ROOT/blocked-no-reason.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
EOF
assert_fails "blocked/no-reason-is-exit-8" 8 "$ROOT/blocked-no-reason.md"
assert_reports "blocked/no-reason-names-the-rule" "blocked-without-reason" "$ROOT/blocked-no-reason.md"

cat >"$ROOT/blocked-empty-reason.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked:
EOF
assert_fails "blocked/empty-reason-is-exit-8" 8 "$ROOT/blocked-empty-reason.md"

# Written with printf, not a heredoc: the trailing whitespace IS the fixture, and
# an editor or a formatter would strip it out of a heredoc without anyone noticing.
# shellcheck disable=SC2016  # the backticks are LITERAL ACs.md markup, not a subshell.
printf -- '- [!] The staging smoke test runs green — `scripts/smoke.sh`\n      - blocked:   \t \n' \
	>"$ROOT/blocked-blank-reason.md"
assert_fails "blocked/whitespace-only-reason-is-exit-8" 8 "$ROOT/blocked-blank-reason.md"

# --authoring relaxes the unticked-explanation rule and ONLY that rule. A
# blocker is written down when it is discovered, which is never "before the
# loop has run an iteration".
assert_fails "blocked/authoring-does-not-relax-the-reason" 8 --authoring "$ROOT/blocked-no-reason.md"

# --- Fields do not mix across states (exit 4, misused field) ---------------
cat >"$ROOT/blocked-with-evidence.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
      - evidence: `scripts/smoke.sh` → green
EOF
assert_fails "blocked/carrying-evidence-is-exit-4" 4 "$ROOT/blocked-with-evidence.md"

cat >"$ROOT/blocked-with-explanation.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
      - explanation: not started.
EOF
assert_fails "blocked/carrying-explanation-is-exit-4" 4 "$ROOT/blocked-with-explanation.md"

cat >"$ROOT/ticked-with-blocked.md" <<'EOF'
- [x] The staging smoke test runs green — `scripts/smoke.sh`
      - evidence: `scripts/smoke.sh` → green
      - blocked: needs production credentials.
EOF
assert_fails "blocked/reason-on-a-ticked-criterion-is-exit-4" 4 "$ROOT/ticked-with-blocked.md"

cat >"$ROOT/unticked-with-blocked.md" <<'EOF'
- [ ] The staging smoke test runs green — `scripts/smoke.sh`
      - explanation: not started.
      - blocked: needs production credentials.
EOF
assert_fails "blocked/reason-on-an-unticked-criterion-is-exit-4" 4 "$ROOT/unticked-with-blocked.md"

# --- §3.3 applies unchanged to the third state ----------------------------
cat >"$ROOT/blocked-no-reference.md" <<'EOF'
- [!] The staging smoke test runs green
      - blocked: needs production credentials.
EOF
assert_fails "blocked/no-specified-system-is-exit-4" 4 "$ROOT/blocked-no-reference.md"

cat >"$ROOT/blocked-surrogate.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/mock-smoke.sh`
      - blocked: needs production credentials.
EOF
assert_fails "blocked/surrogate-reference-is-exit-4" 4 "$ROOT/blocked-surrogate.md"

# --- `[!]` outside a criterion is not a criterion -------------------------
cat >"$ROOT/blocked-prose.md" <<'EOF'
Prose mentioning [!] is not a criterion, and neither is `- [!] ` in a code span.

  - [!] An indented illustration — `scripts/smoke.sh`
        - blocked: illustrative only; not part of the contract.

- [x] The only real criterion — `scripts/smoke.sh`
      - evidence: ran it, green.
EOF
assert_valid "blocked/prose-and-indented-are-not-criteria" "$ROOT/blocked-prose.md"
assert_count "blocked/prose-total-is-one" total 1 "$ROOT/blocked-prose.md"
assert_count "blocked/prose-blocked-is-zero" blocked 0 "$ROOT/blocked-prose.md"

# --- A malformed near-miss is still a format error ------------------------
cat >"$ROOT/blocked-near-miss.md" <<'EOF'
- [!]The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
EOF
assert_fails "blocked/near-miss-checkbox-is-exit-4" 4 "$ROOT/blocked-near-miss.md"

# --- Exit 8 is distinct from every other code in the table ----------------
# A reasonless blocked criterion must not be reported as 4, 5, 6 or 7 — the gate
# maps both delegates' codes through one table and 7 is already taken by
# validate-acs.sh for evidence-not-substantive.
reasonless_status=0
bash "$CHECKER" "$ROOT/blocked-no-reason.md" >/dev/null 2>&1 || reasonless_status=$?
case "$reasonless_status" in
4 | 5 | 6 | 7) fail "blocked/exit-8-does-not-collide" "collided with exit $reasonless_status" ;;
8) pass "blocked/exit-8-does-not-collide" ;;
*) fail "blocked/exit-8-does-not-collide" "expected 8, got $reasonless_status" ;;
esac

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
