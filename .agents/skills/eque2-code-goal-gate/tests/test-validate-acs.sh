#!/usr/bin/env bash
# test-validate-acs.sh — executable conformance suite for validate-acs.sh, the
# gate-side ACs.md validator that defines "permit only when met AND evidenced".
#
# Contract: .claude/skills/prepare-goal/references/acs-format.md
#
# Exercises every required class: happy path, invalid input, boundary,
# empty/null, separated reporting, security boundaries and layering — with the
# governing defect class front and centre (review finding R12): a TICKED
# criterion carrying no evidence must NEVER be accepted as met. That single rule
# is what stops a self-certified tick, and it is asserted from several angles.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# VALIDATOR override (for the non-vacuity mutation check only):
#   VALIDATE_ACS=/path/to/mutant.sh bash test-validate-acs.sh

# shellcheck disable=SC2016
# Backticks throughout this file are LITERAL ACs.md markup inside fixture text
# (a criterion must name its specified system in backticks, and evidence quotes
# commands the same way), never command substitution. Single quotes are
# therefore correct and deliberate.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VALIDATOR="${VALIDATE_ACS:-${TEST_DIR}/../validate-acs.sh}"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/validate-acs-tests.XXXXXX")"

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

# fixture <name> — writes stdin to a fixture file and echoes its path.
fixture() {
	local path="$WORK_DIR/$1"
	mkdir -p -- "$(dirname -- "$path")"
	cat >"$path"
	printf '%s' "$path"
}

# run_validator <args...> — sets RUN_OUT (stdout), RUN_ERR (stderr), RUN_STATUS.
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
run_validator() {
	local errfile
	errfile="$(mktemp "${TMPDIR:-/tmp}/validate-acs-err.XXXXXX")"
	RUN_OUT="$(bash "$VALIDATOR" "$@" 2>"$errfile")"
	RUN_STATUS=$?
	RUN_ERR="$(cat -- "$errfile")"
	rm -f -- "$errfile"
}

# assert_exit <name> <expected-exit> <args...>
assert_exit() {
	local name="$1" expected="$2"
	shift 2
	run_validator "$@"
	if [ "$RUN_STATUS" -eq "$expected" ]; then
		pass "$name"
	else
		fail "$name" "expected exit $expected, got $RUN_STATUS (out=[$RUN_OUT] err=[$RUN_ERR])"
	fi
}

# assert_refused <name> <expected-exit> <args...>
#
# A refusal must satisfy THREE things at once:
#   1. the exact non-zero exit code,
#   2. a `validate-acs:` diagnostic on stderr (no silent failure path), and
#   3. EMPTY STDOUT — the stdout-discipline property, so no caller can ever
#      read a count or a verdict off an error path.
assert_refused() {
	local name="$1" expected="$2"
	shift 2
	run_validator "$@"
	if [ "$RUN_STATUS" -ne "$expected" ]; then
		fail "$name" "expected exit $expected, got $RUN_STATUS (out=[$RUN_OUT] err=[$RUN_ERR])"
		return
	fi
	if [ "$expected" -eq 0 ]; then
		fail "$name" "assert_refused used with a zero exit code"
		return
	fi
	case "$RUN_ERR" in
	*'validate-acs:'*) : ;;
	*)
		fail "$name" "refusal carried no validate-acs: diagnostic (err=[$RUN_ERR])"
		return
		;;
	esac
	if [ -n "$RUN_OUT" ]; then
		fail "$name" "refusal wrote to stdout — a caller could read a verdict off an error path (out=[$RUN_OUT])"
		return
	fi
	pass "$name"
}

# assert_field <name> <key> <expected> — reads a key=value from RUN_OUT.
assert_field() {
	local name="$1" key="$2" expected="$3" got
	got="$(printf '%s\n' "$RUN_OUT" | grep -E "^${key}=" | head -1 | cut -d= -f2-)"
	assert_equals "$name" "$expected" "$got"
}

# assert_stderr_contains <name> <needle>
assert_stderr_contains() {
	local name="$1" needle="$2"
	case "$RUN_ERR" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "stderr did not contain [$needle] (err=[$RUN_ERR])" ;;
	esac
}

# assert_stderr_lacks <name> <needle>
assert_stderr_lacks() {
	local name="$1" needle="$2"
	case "$RUN_ERR" in
	*"$needle"*) fail "$name" "stderr unexpectedly contained [$needle] (err=[$RUN_ERR])" ;;
	*) pass "$name" ;;
	esac
}

# assert_stdout_contains <name> <needle>
assert_stdout_contains() {
	local name="$1" needle="$2"
	case "$RUN_OUT" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "stdout did not contain [$needle] (out=[$RUN_OUT])" ;;
	esac
}

printf '== validate-acs.sh conformance suite ==\n'
printf 'validator: %s\n\n' "$VALIDATOR"

# ===========================================================================
printf -- '-- 1. Happy path -----------------------------------------------\n'
# ===========================================================================

F="$(fixture happy-all-met.md <<'EOF'
# Acceptance criteria

- [x] **CRITICAL** Zero criteria is rejected — `.claude/skills/goal-gate/acs-format-check.sh`
      - evidence: `bash acs-format-check.sh fixtures/empty.md` → `acs-format: no criteria found` (exit 2)
      - at: 2026-07-19T14:02:11Z
- [x] Counting is delegated, never duplicated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
EOF
)"
assert_exit "happy: a fully-formed all-met file validates (exit 0)" 0 "$F"
# 'done' is quoted: bare, it reads as the shell keyword (SC1010), not a value.
assert_field "happy: verdict is done" verdict 'done'
assert_field "happy: total counted" total 2
assert_field "happy: checked counted" checked 2
assert_field "happy: unchecked counted" unchecked 0
assert_field "happy: both ticks carry evidence" ticked_with_evidence 2
assert_field "happy: no tick lacks evidence" ticked_without_evidence 0
assert_field "happy: no prose-only evidence" evidence_not_substantive 0
assert_field "happy: no surrogate evidence" evidence_surrogate 0
assert_field "happy: critical marker counted" critical 1
assert_field "happy: no critical unchecked" critical_unchecked 0
assert_stdout_contains "happy: trail explains criterion 1" 'criterion line=3 state=checked critical=1'
assert_stdout_contains "happy: trail records the met decision" 'decision=met'
assert_stdout_contains "happy: trail explains criterion 2" 'criterion line=6 state=checked critical=0'

F="$(fixture happy-mixed.md <<'EOF'
- [x] The parser refuses zero criteria — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: ran `bash parse-acs.sh empty.md`, got exit 2
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: blocked on T3.4; the live invocation has not been run yet.
EOF
)"
assert_exit "happy: a well-formed but unfinished file is valid-but-not-done (exit 1)" 1 "$F"
assert_field "happy/mixed: verdict is not_done" verdict not_done
assert_field "happy/mixed: one unchecked" unchecked 1
assert_field "happy/mixed: explained unmet criterion counted" unticked_with_explanation 1
assert_field "happy/mixed: none unexplained" unticked_without_explanation 0
assert_stdout_contains "happy/mixed: trail records not_met" 'state=unchecked'
assert_stdout_contains "happy/mixed: trail records the explanation" 'explanation=present'

run_validator --quiet "$F"
assert_equals "happy: --quiet suppresses the trail" "0" "$(printf '%s\n' "$RUN_OUT" | grep -c '^criterion ')"
assert_field "happy: --quiet still emits counts" total 2

# ===========================================================================
printf -- '\n-- 2. THE LEAD FINDING (R12): ticked without evidence ----------\n'
# ===========================================================================

F="$(fixture r12-tick-no-evidence.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
EOF
)"
assert_refused "R12: a ticked criterion with NO evidence line is REFUSED (exit 5)" 5 "$F"
assert_stderr_contains "R12: refusal is named ticked-without-evidence" 'ticked-without-evidence'
assert_stderr_contains "R12: the offending line is identified" 'line 1'
assert_stderr_lacks "R12: a refused tick is never reported as met" 'decision=met'

F="$(fixture r12-tick-no-evidence-among-good.md <<'EOF'
- [x] Counting is delegated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` → 160/160 PASS (exit 0)
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
- [x] Format is checked — `.claude/skills/goal-gate/acs-format-check.sh`
      - evidence: `bash acs-format-check.sh ACs.md` (exit 0)
EOF
)"
assert_refused "R12: ONE unevidenced tick among evidenced ones still refuses the whole file" 5 "$F"
assert_stderr_contains "R12: the unevidenced tick is located, not just counted" 'line 3'

F="$(fixture r12-tick-empty-evidence.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence:
EOF
)"
assert_refused "R12: an EMPTY evidence line is refused (exit 5)" 5 "$F"

F="$(fixture r12-tick-whitespace-evidence.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence:
EOF
)"
assert_refused "R12: a WHITESPACE-ONLY evidence line is refused (exit 5)" 5 "$F"

F="$(fixture r12-all-ticked-none-evidenced.md <<'EOF'
- [x] One — `.claude/skills/goal-gate/a.sh`
- [x] Two — `.claude/skills/goal-gate/b.sh`
- [x] Three — `.claude/skills/goal-gate/c.sh`
EOF
)"
assert_refused "R12: an all-ticked, wholly unevidenced file is NOT 'done' (exit 5)" 5 "$F"

# The rule holds in authoring mode too: --authoring relaxes the EXPLANATION
# rule only. A tick still has to be evidenced, or the relaxation would become a
# bypass for the very rule this feature exists to enforce.
assert_refused "R12: --authoring does NOT relax the evidence rule" 5 --authoring "$F"

# ===========================================================================
printf -- '\n-- 3. Evidence substance: prose alone is not evidence ----------\n'
# ===========================================================================

F="$(fixture prose-evidence.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: I checked this carefully and it definitely works
EOF
)"
assert_refused "substance: prose with no command, result or artefact is refused (exit 7)" 7 "$F"
assert_stderr_contains "substance: refusal is named evidence-not-substantive" 'evidence-not-substantive'

F="$(fixture prose-evidence-confident.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: done, verified, all good, trust me
EOF
)"
assert_refused "substance: a confident assertion is still not evidence" 7 "$F"

F="$(fixture evidence-backtick-nonpath.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: it printed `ok` when I looked
EOF
)"
assert_refused "substance: a backticked word that is not a path/command is not evidence" 7 "$F"

# The three accepted shapes, each asserted independently so a regression in any
# one of them is visible on its own.
F="$(fixture evidence-by-command.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash .claude/skills/goal-gate/run-all.sh` printed a refusal
EOF
)"
assert_exit "substance: a backticked command IS evidence (exit 0)" 0 "$F"

F="$(fixture evidence-by-exit.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: ran the gate over a half-done checklist and it returned exit 1
EOF
)"
assert_exit "substance: an explicit exit status IS evidence (exit 0)" 0 "$F"

F="$(fixture evidence-by-arrow.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: run the gate on a half-done checklist -> it refuses the stop
EOF
)"
assert_exit "substance: a command-to-result arrow IS evidence (exit 0)" 0 "$F"

F="$(fixture evidence-by-artefact.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: transcript saved at `journal/transcripts/T1.6-build.md`
EOF
)"
assert_exit "substance: a named artefact IS evidence (exit 0)" 0 "$F"

# ===========================================================================
printf -- '\n-- 4. Evidence naming a surrogate ------------------------------\n'
# ===========================================================================

F="$(fixture evidence-surrogate.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash tests/mock-run-all.sh` → refused (exit 1)
EOF
)"
assert_refused "surrogate: a tick evidenced against a mock is refused (exit 7)" 7 "$F"
assert_stderr_contains "surrogate: refusal is named evidence-names-surrogate" 'evidence-names-surrogate'

F="$(fixture evidence-surrogate-stub.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: ran `./stub-gate.sh` and it returned exit 1
EOF
)"
assert_refused "surrogate: a stub is refused even when it carries an exit status" 7 "$F"

F="$(fixture evidence-surrogate-fake.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `FAKE-runner.sh` → ok
EOF
)"
assert_refused "surrogate: the vocabulary is case-insensitive" 7 "$F"

# ===========================================================================
printf -- '\n-- 5. A criterion naming no specified system -------------------\n'
# ===========================================================================

F="$(fixture no-reference.md <<'EOF'
- [x] The parser rejects empty files
      - evidence: `bash parse-acs.sh empty.md` → exit 2
EOF
)"
assert_refused "reference: a criterion naming no path or entry point is refused (exit 4)" 4 "$F"
assert_stderr_contains "reference: the delegated checker names the failure" 'names no specified system'

F="$(fixture surrogate-reference.md <<'EOF'
- [x] The gate refuses a stop — `tests/mock-gate.sh`
      - evidence: `bash tests/mock-gate.sh` → exit 1
EOF
)"
assert_refused "reference: a criterion phrased against a surrogate is refused (exit 4)" 4 "$F"
assert_stderr_contains "reference: surrogate substitution fails the FORMAT, not the gate" 'surrogate-reference'

# ===========================================================================
printf -- '\n-- 6. Unticked without explanation, reported SEPARATELY --------\n'
# ===========================================================================

F="$(fixture unticked-no-explanation.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
EOF
)"
assert_refused "explanation: an unmet criterion with no explanation is refused (exit 6)" 6 "$F"
assert_stderr_contains "explanation: refusal is named unticked-without-explanation" 'unticked-without-explanation'

# The separation requirement: the two unticked states must never be conflated
# into one bucket. A file carrying one of each must report exactly one in each
# counter — that is what makes an unaccounted-for criterion visible rather than
# absorbed into a count of properly accounted-for ones.
F="$(fixture unticked-mixed.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: blocked on T3.4.
- [ ] The run log is emitted — `.claude/skills/goal-gate/run-all.sh`
EOF
)"
assert_refused "explanation: one explained + one unexplained still refuses (exit 6)" 6 "$F"
assert_stderr_contains "explanation: the UNexplained criterion is the one located" 'line 3'
assert_stderr_lacks "explanation: the explained criterion is NOT reported" 'line 1:'

F="$(fixture unticked-both-explained.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: blocked on T3.4.
- [ ] The run log is emitted — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not started.
EOF
)"
assert_exit "explanation: two explained unmet criteria are valid-but-not-done (exit 1)" 1 "$F"
assert_field "separation: unticked_with_explanation counts exactly the explained" unticked_with_explanation 2
assert_field "separation: unticked_without_explanation is a DISTINCT counter" unticked_without_explanation 0

# --authoring relaxes this rule and ONLY this rule (§5).
assert_exit "explanation: --authoring relaxes the explanation rule (exit 1)" 1 --authoring "$F"
F="$(fixture unticked-authoring.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
EOF
)"
assert_refused "explanation: strict is the DEFAULT, so fail-closed is what you get" 6 "$F"
assert_exit "explanation: --authoring accepts a freshly emitted checklist (exit 1)" 1 --authoring "$F"
assert_field "authoring: the unexplained criterion is not counted as a violation" unticked_without_explanation 0

# ===========================================================================
printf -- '\n-- 7. Boundary: fields on the wrong state ----------------------\n'
# ===========================================================================

F="$(fixture evidence-on-unticked.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - evidence: `bash register.sh` → exit 0
EOF
)"
assert_refused "boundary: evidence on an UNTICKED criterion is refused (exit 4)" 4 "$F"

F="$(fixture explanation-on-ticked.md <<'EOF'
- [x] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: it seemed fine when I looked
EOF
)"
assert_refused "boundary: explanation on a TICKED criterion is refused" 5 "$F"
assert_stderr_contains "boundary: a tick that explains instead of evidencing is self-certification" 'ticked-without-evidence'

F="$(fixture both-fields.md <<'EOF'
- [x] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - evidence: `bash register.sh` → exit 0
      - explanation: also worth noting
EOF
)"
assert_refused "boundary: a ticked criterion carrying BOTH fields is refused (exit 4)" 4 "$F"

# ===========================================================================
printf -- '\n-- 8. Empty / null -------------------------------------------\n'
# ===========================================================================

F="$(fixture zero-criteria.md <<'EOF'
# Acceptance criteria

Nothing has been written down yet.
EOF
)"
assert_refused "empty: zero criteria is an ERROR, never 'all complete' (exit 2)" 2 "$F"

: >"$WORK_DIR/empty-file.md"
assert_refused "empty: an empty file is refused (exit 2)" 2 "$WORK_DIR/empty-file.md"

assert_refused "null: a missing file is refused (exit 3)" 3 "$WORK_DIR/does-not-exist.md"
assert_refused "null: a directory is refused (exit 3)" 3 "$WORK_DIR"
assert_refused "null: an empty path argument is refused (exit 3)" 3 ""
assert_exit "usage: no argument is a usage error (exit 64)" 64
assert_exit "usage: an unknown option is a usage error (exit 64)" 64 --nope "$WORK_DIR/empty-file.md"
assert_exit "usage: two paths are a usage error (exit 64)" 64 a.md b.md

# ===========================================================================
printf -- '\n-- 9. SECURITY: evidence text is never evaluated as shell ------\n'
# ===========================================================================

CANARY="$WORK_DIR/canary-must-not-exist"
rm -f -- "$CANARY"

F="$(fixture security-command-substitution.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: $(touch CANARY_PATH) `run-all.sh` returned exit 1
EOF
)"
# Substitute the real canary path into the fixture WITHOUT letting the shell
# expand it here either.
python3 - "$F" "$CANARY" <<'PY'
import sys
p, canary = sys.argv[1], sys.argv[2]
with open(p) as fh:
    data = fh.read()
with open(p, "w") as fh:
    fh.write(data.replace("CANARY_PATH", canary))
PY
run_validator "$F"
if [ -e "$CANARY" ]; then
	fail "security: \$(...) in evidence must not be executed" "the canary file was created"
else
	pass "security: \$(...) in evidence is inert data"
fi

F="$(fixture security-semicolon.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `run-all.sh`; rm -rf /; echo pwned (exit 1)
EOF
)"
run_validator "$F"
assert_equals "security: shell metacharacters in evidence do not derail the run" "0" "$RUN_STATUS"

F="$(fixture security-backtick-command.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `id > /tmp/nope.txt` (exit 0)
EOF
)"
rm -f -- /tmp/nope.txt
run_validator "$F"
if [ -e /tmp/nope.txt ]; then
	fail "security: a backticked command in evidence must not be executed" "/tmp/nope.txt was created"
	rm -f -- /tmp/nope.txt
else
	pass "security: a backticked command in evidence is inert data"
fi

F="$(fixture security-glob.md <<'EOF'
- [x] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: * ? [a-z] `run-all.sh` (exit 1)
EOF
)"
run_validator "$F"
assert_equals "security: glob characters in evidence are not expanded" "0" "$RUN_STATUS"

F="$(fixture security-explanation.md <<'EOF'
- [ ] The gate refuses to permit a stop — `.claude/skills/goal-gate/run-all.sh`
      - explanation: $(touch /tmp/nope2.txt) blocked on T3.4
EOF
)"
rm -f -- /tmp/nope2.txt
run_validator "$F"
if [ -e /tmp/nope2.txt ]; then
	fail "security: \$(...) in an explanation must not be executed" "/tmp/nope2.txt was created"
	rm -f -- /tmp/nope2.txt
else
	pass "security: \$(...) in an explanation is inert data"
fi

F="$(fixture security-criterion-text.md <<'EOF'
- [x] $(touch /tmp/nope3.txt) is refused — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
rm -f -- /tmp/nope3.txt
run_validator "$F"
if [ -e /tmp/nope3.txt ]; then
	fail "security: \$(...) in criterion text must not be executed" "/tmp/nope3.txt was created"
	rm -f -- /tmp/nope3.txt
else
	pass "security: \$(...) in criterion text is inert data"
fi

# ===========================================================================
printf -- '\n-- 10. The --require-critical policy ---------------------------\n'
# ===========================================================================

F="$(fixture critical-mixed.md <<'EOF'
- [x] **CRITICAL** The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
- [x] Counting is delegated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` (exit 0)
EOF
)"
assert_exit "critical: the marker is OPTIONAL by default, per the normative contract" 0 "$F"
assert_field "critical: markers are counted" critical 1
assert_refused "critical: --require-critical enforces a marker on every criterion (exit 4)" 4 --require-critical "$F"
assert_stderr_contains "critical: refusal is named missing-critical-marker" 'missing-critical-marker'
# The unmarked criterion is the checkbox line (3), not its evidence line (4).
assert_stderr_contains "critical: the unmarked criterion is located" 'line 3'

F="$(fixture critical-all.md <<'EOF'
- [x] **CRITICAL** The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
- [x] **CRITICAL** Counting is delegated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` (exit 0)
EOF
)"
assert_exit "critical: --require-critical passes when every criterion is marked" 0 --require-critical "$F"
assert_field "critical: all markers counted" critical 2

F="$(fixture critical-misplaced.md <<'EOF'
- [x] The gate **CRITICAL** refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_refused "critical: a misplaced marker is a format error (delegated, exit 4)" 4 "$F"

F="$(fixture critical-unchecked.md <<'EOF'
- [ ] **CRITICAL** The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not built yet.
- [ ] Counting is delegated — `.claude/skills/goal-gate/parse-acs.sh`
      - explanation: not built yet.
EOF
)"
assert_exit "critical: an unmet critical criterion is valid-but-not-done (exit 1)" 1 "$F"
assert_field "critical: critical_unchecked distinguishes load-bearing gaps" critical_unchecked 1

# ===========================================================================
printf -- '\n-- 11. Layering: illustrations and delegation ------------------\n'
# ===========================================================================

F="$(fixture nested-illustration.md <<'EOF'
Worked example — the indented item below is an illustration, not a criterion:

  - [x] This is only an example — `some/path.sh`
        - evidence: not a real claim

- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_exit "layering: an INDENTED task item is an illustration, not a criterion" 0 "$F"
assert_field "layering: only the top-level item is counted" total 1
assert_stdout_contains "layering: the trail describes the real criterion only" 'criterion line=6'

F="$(fixture fenced-example.md <<'EOF'
A fenced example must not become part of the contract:

```markdown
- [ ] An unmet example with no explanation — `example/path.sh`
```

- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
# FAIL CLOSED on a layering divergence, asserted deliberately.
#
# The normative contract (§3.1, §6) makes INDENTATION the mechanism by which an
# illustration is excluded from the checklist; it says nothing about fenced code
# blocks. parse-acs.sh (T1.3) nonetheless skips fenced content, and this script's
# trail scan mirrors it — but acs-format-check.sh (T1.2), the NORMATIVE
# implementation, does not. So an UNINDENTED pseudo-criterion inside a fence is
# invisible to the counting layer and visible to the lexical layer.
#
# That divergence is not this task's to resolve (T1.2 and T1.3 are complete and
# green, and the normative document is on the lexical layer's side). What IS this
# task's to guarantee is the standing constraint: an ambiguity between layers
# must resolve to REFUSAL, never to a permit. It does — the delegated lexical
# layer refuses (exit 4) and nothing reaches stdout, so a criterion cannot be
# smuggled past the gate by hiding it in a fence.
#
# Asserted as the refusal it actually is. Writing this as `exit 0` would have
# been asserting a convenient fiction; the divergence is recorded in the journal
# for whoever reconciles the two layers.
assert_refused "layering: an unindented pseudo-criterion in a fence FAILS CLOSED (exit 4)" 4 "$F"
assert_stderr_contains "layering: the divergence surfaces as a refusal, not a permit" 'acs-format:'

F="$(fixture indented-example.md <<'EOF'
The normative mechanism — indentation — excludes an illustration cleanly:

  - [ ] An unmet example with no explanation — `example/path.sh`

- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_exit "layering: an INDENTED example is excluded by the normative mechanism" 0 "$F"
assert_field "layering: the indented item is not counted" total 1

F="$(fixture nonconforming.md <<'EOF'
* [x] A non-canonical list prefix — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_refused "layering: parse-acs's refusal of a non-canonical criterion is propagated (exit 4)" 4 "$F"
assert_stderr_contains "layering: the delegated diagnostic is surfaced, not swallowed" 'parse-acs'

F="$(fixture unknown-box.md <<'EOF'
- [X] An unreadable checkbox state — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_refused "layering: an unknown checkbox state is refused, never guessed (exit 4)" 4 "$F"

F="$(fixture conflict.md <<'EOF'
<<<<<<< HEAD
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
=======
- [ ] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not done.
>>>>>>> feature
EOF
)"
assert_refused "layering: a merge-conflicted file has no readable verdict (exit 6)" 6 "$F"

ln -sf "$WORK_DIR/happy-all-met.md" "$WORK_DIR/link.md"
assert_refused "layering: a symlinked ACs.md is refused (exit 3)" 3 "$WORK_DIR/link.md"

# An unrunnable check resolves to NOT DONE — never to "nothing to report".
ISOLATED="$WORK_DIR/isolated"
mkdir -p "$ISOLATED"
cp "$VALIDATOR" "$ISOLATED/validate-acs.sh"
run_out_isolated=$(bash "$ISOLATED/validate-acs.sh" "$WORK_DIR/happy-all-met.md" 2>/dev/null)
isolated_status=$?
assert_equals "fail-closed: a validator with no parser beside it refuses (exit 3)" "3" "$isolated_status"
assert_equals "fail-closed: and writes nothing to stdout" "" "$run_out_isolated"

# ===========================================================================
printf -- '\n-- 12. Boundary: shapes that must still work -------------------\n'
# ===========================================================================

F="$(fixture boundary-blank-lines.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`

      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_exit "boundary: a blank line does not end a criterion (§6)" 0 "$F"

F="$(fixture boundary-long-explanation.md <<'EOF'
- [ ] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - explanation: this is blocked on T3.4 and the reasoning is long, deliberately, because the contract sets no length limit on an explanation and a very long one must remain valid rather than being truncated or refused on size alone, which would push authors toward terse and useless explanations.
EOF
)"
assert_exit "boundary: there is no length limit on an explanation (§5)" 1 "$F"

F="$(fixture boundary-crlf.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
with open(p, "rb") as fh:
    data = fh.read()
with open(p, "wb") as fh:
    fh.write(data.replace(b"\n", b"\r\n"))
PY
assert_exit "boundary: CRLF line endings are handled" 0 "$F"

F="$(fixture boundary-no-trailing-newline.md)"
printf -- '- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`\n      - evidence: `bash run-all.sh` (exit 1)' >"$F"
assert_exit "boundary: a file with no trailing newline is handled" 0 "$F"

F="$(fixture boundary-first-evidence-wins.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
      - evidence: and also some prose
EOF
)"
assert_exit "boundary: the first evidence line is the one classified" 0 "$F"

F="$(fixture boundary-many.md)"
{
	for i in $(seq 1 50); do
		printf -- '- [x] Criterion %s — `.claude/skills/goal-gate/step-%s.sh`\n' "$i" "$i"
		printf -- '      - evidence: `bash step-%s.sh` (exit 0)\n' "$i"
	done
} >"$F"
assert_exit "boundary: fifty evidenced criteria validate (exit 0)" 0 "$F"
assert_field "boundary: all fifty counted" total 50
assert_field "boundary: all fifty evidenced" ticked_with_evidence 50

F="$(fixture boundary-many-one-bad.md)"
{
	for i in $(seq 1 50); do
		printf -- '- [x] Criterion %s — `.claude/skills/goal-gate/step-%s.sh`\n' "$i" "$i"
		if [ "$i" != "37" ]; then
			printf -- '      - evidence: `bash step-%s.sh` (exit 0)\n' "$i"
		fi
	done
} >"$F"
assert_refused "boundary: one unevidenced tick among fifty is still found (exit 5)" 5 "$F"
assert_stderr_contains "boundary: and is located precisely" 'line 73'

# ===========================================================================
printf -- '\n-- 13. THIS layer enforces its own rules, not just inherits them -\n'
# ===========================================================================
#
# WHY THIS SECTION EXISTS — it was added because a mutation check proved the
# sections above were partly VACUOUS.
#
# acs-format-check.sh independently refuses ticked-without-evidence (exit 5) and
# unticked-without-explanation (exit 6). Because validate-acs.sh delegates to it,
# every test above that asserts those refusals is satisfied by the DELEGATE
# alone. Deleting this script's own enforcement of the empty-evidence rule, or
# merging its separate unticked buckets into one, left the whole suite green.
# Those rules were being asserted by proxy and were not actually under test.
#
# So this section isolates the layer: the real validate-acs.sh and the real
# parse-acs.sh, beside a PERMISSIVE acs-format-check.sh that approves everything.
# Whatever refuses now is this script refusing on its own authority.
#
# The permissive stub is a surrogate, and using one is normally the failure this
# whole feature exists to catch. It is justified here for one narrow reason: the
# property under test is "this layer refuses WITHOUT help", which cannot be
# observed while the helper is present. The integrated behaviour — real checker,
# real parser — is what every other section asserts. Both are needed; neither
# alone is sufficient.

LAYER="$WORK_DIR/isolated-layer"
mkdir -p "$LAYER"
cp "$VALIDATOR" "$LAYER/validate-acs.sh"
cp "$TEST_DIR/../parse-acs.sh" "$LAYER/parse-acs.sh"
cat >"$LAYER/acs-format-check.sh" <<'STUB'
#!/usr/bin/env bash
# Permissive stand-in: approves every file, so that any refusal observed in
# section 13 is validate-acs.sh's own and cannot have been inherited.
exit 0
STUB

# run_isolated <args...> — same capture contract as run_validator.
run_isolated() {
	local errfile
	errfile="$(mktemp "${TMPDIR:-/tmp}/validate-acs-iso.XXXXXX")"
	RUN_OUT="$(bash "$LAYER/validate-acs.sh" "$@" 2>"$errfile")"
	RUN_STATUS=$?
	RUN_ERR="$(cat -- "$errfile")"
	rm -f -- "$errfile"
}

# assert_isolated <name> <expected-exit> <args...>
assert_isolated() {
	local name="$1" expected="$2"
	shift 2
	run_isolated "$@"
	if [ "$RUN_STATUS" -eq "$expected" ]; then
		pass "$name"
	else
		fail "$name" "expected exit $expected, got $RUN_STATUS (out=[$RUN_OUT] err=[$RUN_ERR])"
	fi
}

# Sanity: the harness really is permissive, or every assertion below is hollow.
F="$(fixture iso-control.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh` (exit 1)
EOF
)"
assert_isolated "isolation/control: a well-formed file still passes the harness" 0 "$F"

# R12, on this layer's own authority.
F="$(fixture iso-tick-no-evidence.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
EOF
)"
assert_isolated "isolation: THIS script refuses a tick with no evidence, unaided (exit 5)" 5 "$F"
assert_stderr_contains "isolation: and names it ticked-without-evidence" 'validate-acs: line 1: ticked-without-evidence'

F="$(fixture iso-tick-empty-evidence.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence:
EOF
)"
assert_isolated "isolation: THIS script refuses EMPTY evidence, unaided (exit 5)" 5 "$F"
assert_stderr_contains "isolation: and reports the emptiness specifically" "'evidence:' is empty"

# The separated buckets, on this layer's own authority.
F="$(fixture iso-unticked-no-explanation.md <<'EOF'
- [ ] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
EOF
)"
assert_isolated "isolation: THIS script refuses an unexplained unmet criterion (exit 6)" 6 "$F"
assert_stderr_contains "isolation: and names it unticked-without-explanation" 'validate-acs: line 1: unticked-without-explanation'

# Non-conflation, asserted on a PRINTED output. Under --authoring the unexplained
# criterion is tolerated, so both counters are emitted and can be compared — the
# only place in the suite where merging the two buckets is directly visible.
F="$(fixture iso-unticked-mixed.md <<'EOF'
- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: blocked on T3.4.
- [ ] The run log is emitted — `.claude/skills/goal-gate/run-all.sh`
EOF
)"
assert_isolated "isolation: --authoring tolerates the unexplained criterion (exit 1)" 1 --authoring "$F"
assert_field "isolation: ONLY the explained criterion lands in the explained bucket" unticked_with_explanation 1
assert_field "isolation: the unexplained one is NOT absorbed into it" unticked_without_explanation 0
assert_stdout_contains "isolation: the trail marks the explained criterion" 'explanation=present'
assert_stdout_contains "isolation: and marks the unexplained one distinctly" 'explanation=absent'

# Evidence substance and surrogate rules are this script's alone already, but
# assert them unaided too so the whole enforcement set is covered by isolation.
F="$(fixture iso-prose.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: I checked it and it works
EOF
)"
assert_isolated "isolation: THIS script refuses prose-only evidence (exit 7)" 7 "$F"

F="$(fixture iso-surrogate.md <<'EOF'
- [x] The gate refuses a stop — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash tests/mock-run-all.sh` → exit 1
EOF
)"
assert_isolated "isolation: THIS script refuses surrogate evidence (exit 7)" 7 "$F"

# ===========================================================================
printf -- '\n-- 14. Help and sourcing ---------------------------------------\n'
# ===========================================================================

assert_exit "help: --help exits 0" 0 --help
assert_stdout_contains "help: --help documents the honest limit" 'HONEST LIMIT'
assert_stdout_contains "help: --help states it cannot check truthfulness" 'TRUTHFULNESS'

SOURCE_PROBE="$WORK_DIR/source-probe.sh"
cat >"$SOURCE_PROBE" <<PROBE
#!/usr/bin/env bash
before="\$-"
# shellcheck source=/dev/null
. "$VALIDATOR"
after="\$-"
[ "\$before" = "\$after" ] || { printf 'shell options changed: %s -> %s\n' "\$before" "\$after"; exit 1; }
exit 0
PROBE
if bash "$SOURCE_PROBE" >/dev/null 2>&1; then
	pass "sourcing: sourcing the validator does not alter the caller's shell options"
else
	fail "sourcing: sourcing the validator does not alter the caller's shell options" "probe failed"
fi

# ===========================================================================
# The blocked state — enforcement, the decision trail, and what is NOT enforced
# ===========================================================================

BLK="$(fixture blocked-partial.md <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] **CRITICAL** Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials this run does not have and cannot mint.
EOF
)"

# Nothing outstanding, one blocked: a REPORTED NON-COMPLETION. The load-bearing
# assertion is exit 1 — testing `unchecked=0` alone would hand exit 0 to exactly
# the case this feature exists to refuse.
assert_exit "blocked: nothing outstanding but one blocked is NOT a pass (exit 1)" 1 "$BLK"
assert_field "blocked: verdict is partial" verdict 'partial'
assert_field "blocked: counted" blocked 1
assert_field "blocked: unchecked is zero" unchecked 0
assert_field "blocked: never added to checked" checked 1
assert_field "blocked: reason counted separately" blocked_with_reason 1
assert_field "blocked: no reasonless blockers" blocked_without_reason 0
# Reported separately from the unticked counts — conflating "cannot be done"
# with "not done yet" is what would put a blocker back into the nudge.
assert_field "blocked: not counted as unticked-with-explanation" unticked_with_explanation 0
assert_field "blocked: not counted as unticked-without-explanation" unticked_without_explanation 0
# A blocked CRITICAL is critical, but it is not OUTSTANDING.
assert_field "blocked: critical marker still counted" critical 1
assert_field "blocked: blocked critical is not critical_unchecked" critical_unchecked 0
assert_stdout_contains "blocked: trail names the blocked state" 'state=blocked'
assert_stdout_contains "blocked: trail records its own decision" 'decision=blocked'
assert_stdout_contains "blocked: trail records the reason as present" 'reason=present'

# --- All blocked: still not a pass ----------------------------------------
BLK_blocked_all="$(fixture blocked-all.md <<'EOF'
- [!] Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials.
- [!] Also cannot — `scripts/c.sh`
      - blocked: same credential wall.
EOF
)"
assert_exit "blocked: an all-blocked checklist is not a pass (exit 1)" 1 "$BLK_blocked_all"
assert_field "blocked: all-blocked has zero met" checked 0
assert_field "blocked: all-blocked verdict is partial" verdict 'partial'

# --- The reason is mandatory, and its refusal is NAMED --------------------
BLK_blocked_reasonless="$(fixture blocked-reasonless.md <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] Cannot be done — `scripts/b.sh`
EOF
)"
assert_refused "blocked: a reasonless blocker is refused with exit 8" 8 "$BLK_blocked_reasonless"
assert_stderr_contains "blocked: the refusal names blocked-without-reason" 'blocked-without-reason'

BLK_blocked_empty_reason="$(fixture blocked-empty-reason.md <<'EOF'
- [!] Cannot be done — `scripts/b.sh`
      - blocked:
EOF
)"
assert_refused "blocked: an empty reason is refused with exit 8" 8 "$BLK_blocked_empty_reason"

# --authoring relaxes the unticked-explanation rule and ONLY that rule.
assert_refused "blocked: --authoring does not relax the blocked reason" 8 \
	--authoring "$BLK_blocked_reasonless"

# --- SECURITY BOUNDARY: a reason is prose, and stays prose ----------------
# The evidence-substance and surrogate rules apply to `evidence:`, where the
# claim is "I did this". A `blocked:` value claims "I cannot", and prose is a
# complete and honest answer to that. Demanding a command of a reason would make
# honest blockers unwriteable and push authors back to leaving the loop
# spinning — the very defect this feature closes. This test exists so a later
# "hardening" cannot quietly add that rule.
BLK_blocked_prose_reason="$(fixture blocked-prose-reason.md <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] Cannot be done — `scripts/b.sh`
      - blocked: we simply do not have the credentials and cannot obtain them.
EOF
)"
assert_exit "blocked: a prose reason is accepted, not judged for substance" 1 "$BLK_blocked_prose_reason"
assert_field "blocked: prose reason counts as present" blocked_with_reason 1
assert_field "blocked: prose reason is not evidence-not-substantive" evidence_not_substantive 0

# A reason MENTIONING a surrogate is still a valid reason — "the mock server is
# all we have" is a real blocker, not a surrogate-evidenced tick.
BLK_blocked_surrogate_reason="$(fixture blocked-surrogate-reason.md <<'EOF'
- [!] Cannot be done — `scripts/b.sh`
      - blocked: only a mock upstream exists in this environment; the real one is unreachable.
EOF
)"
assert_exit "blocked: a reason mentioning a stand-in is not a surrogate refusal" 1 "$BLK_blocked_surrogate_reason"
assert_field "blocked: surrogate rule did not fire on the reason" evidence_surrogate 0

# --- Backwards compatibility ---------------------------------------------
# A two-state file produces its previous trail and exit, plus a zero count.
BLK_two_state="$(fixture blocked-two-state.md <<'EOF'
- [x] **CRITICAL** Zero criteria is rejected — `.claude/skills/goal-gate/acs-format-check.sh`
      - evidence: `bash acs-format-check.sh fixtures/empty.md` → exit 2
- [x] Counting is delegated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` → 184 passed, 0 failed (exit 0)
EOF
)"
assert_exit "blocked: a two-state all-met file still exits 0" 0 "$BLK_two_state"
assert_field "blocked: two-state file reports blocked=0" blocked 0
assert_field "blocked: two-state file reports blocked_with_reason=0" blocked_with_reason 0
assert_field "blocked: two-state file reports blocked_without_reason=0" blocked_without_reason 0

# --- The surrogate rule must not fire on "outstanding" --------------------
# `standin` as a bare substring lives inside "outstanding" — this system's own
# core vocabulary. Evidence quoting the gate's own "N met, N outstanding" output
# was refused as surrogate-evidenced, which made the honest record unwriteable.
BLK_outstanding="$(fixture blocked-outstanding-word.md <<'EOF'
- [x] The status report names the counts — `.claude/skills/goal-gate/cancel.sh`
      - evidence: `bash cancel.sh status` printed `last evaluation: 1 met, 0 outstanding, 1 BLOCKED`
EOF
)"
assert_exit "blocked: 'outstanding' in evidence is not a surrogate reference" 0 "$BLK_outstanding"
assert_field "blocked: the surrogate rule did not fire on 'outstanding'" evidence_surrogate 0
# ...but a real stand-in still is one.
BLK_realstandin="$(fixture blocked-real-standin.md <<'EOF'
- [x] The status report names the counts — `.claude/skills/goal-gate/cancel.sh`
      - evidence: `bash standin/cancel.sh status` → exit 0
EOF
)"
assert_refused "blocked: a genuine standin reference is still refused" 7 "$BLK_realstandin"

# ===========================================================================
printf '\n== summary ==\n'
printf 'passed: %d\n' "$PASS_COUNT"
printf 'failed: %d\n' "$FAIL_COUNT"

if [ "$FAIL_COUNT" -ne 0 ]; then
	printf 'RESULT: FAIL\n'
	exit 1
fi
printf 'RESULT: PASS\n'
exit 0
