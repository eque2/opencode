#!/usr/bin/env bash
# run-all.sh — the full quality gate for this feature (T5.3).
#
# Gate commands are PINNED in the spec's context.md. They are not re-derived
# here, and `npm run test` is never adopted: the root package.json script is
# `echo "Error: no test specified" && exit 1`, which fails unconditionally and
# tests nothing. It is a decoy, and "fixing" it to make a gate pass would be
# fabricating the gate rather than passing it.
#
# WHY THIS SCRIPT COUNTS EXECUTED TESTS. A green suite that ran nothing is the
# vacuous-truth trap one level up from the gate's own: every file exits 0, the
# summary says PASS, and nothing was verified. So:
#
#   * every suite reports a PER-FILE executed-test count, not just a total —
#     "non-zero total" alone is satisfied by one trivial test (review finding R9);
#   * a suite that executes ZERO tests FAILS, even if it exits 0;
#   * every test file named in tasks.md must exist AND execute at least one
#     test. A file that is named but absent is a hole in the gate, not a
#     smaller gate.
#
# LIVE-AGENT TESTS ARE REPORTED AS SKIPPED, NEVER PASSED OVER (R15/R17). They
# cost a real session, so they do not run here by default — but they are printed
# as `SKIPPED (live)` and named, so a reader can never mistake this suite for
# proof that the gate fires under a real agent. Run them with GOAL_GATE_LIVE=1.
#
# Usage:
#   run-all.sh [--quick] [--list]
#
#   --quick   skip the slowest suites (they sleep for timing assertions)
#   --list    print the plan and exit, running nothing
#
# Exit: 0 only when every gate step passed and every named suite executed tests.
#       2 when every step that ran passed but --quick skipped some (a partial
#         gate must not be readable as a full one from $? alone).
#       1 on any failure.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd -- "$TEST_DIR/.." && pwd -P)"
REPO_ROOT="$(git -C "$SKILL_DIR" rev-parse --show-toplevel 2>/dev/null)" ||
	REPO_ROOT="$(cd -- "$SKILL_DIR/../../.." && pwd -P)"
TASKS="${GOAL_GATE_TASKS:-$REPO_ROOT/_bmad-output/specs/spec-prepare-goal-v2/tasks.md}"

# HERMETIC PROOF MARKER — do not remove.
#
# Twelve of these suites fire the gate, and the gate records a proof-of-fire at
# its DEFAULT per-machine path. So running this suite rewrote the developer's
# real Codex proof, pointing it at a checkout copy. That was invisible while the
# marker keyed on content alone — every copy of goal-gate-stop.sh is
# byte-identical, so the wrong path still hashed right — and became a hard block
# the moment the marker keyed on the registered command instead.
#
# A test suite must never be able to revoke a machine's proof. This fails CLOSED:
# without a sandbox we refuse to run rather than trash the real marker.
POF_SANDBOX="$(mktemp -d 2>/dev/null)" || POF_SANDBOX=""
if [ -z "$POF_SANDBOX" ]; then
	printf 'run-all: FATAL — no sandbox for the proof marker; refusing to run rather than overwrite the real one.\n' >&2
	exit 1
fi
export GOAL_GATE_PROOF_DIR="$POF_SANDBOX/proof"
trap 'rm -rf -- "$POF_SANDBOX" 2>/dev/null || true' EXIT

QUICK=0
LIST=0
for arg in "$@"; do
	case "$arg" in
	--quick) QUICK=1 ;;
	--list) LIST=1 ;;
	*)
		printf 'run-all: unknown option: %s\n' "$arg" >&2
		exit 64
		;;
	esac
done

# Suites that sleep for timing assertions. Skipped only under --quick, and
# reported as skipped when they are.
SLOW_SUITES="test-stall.sh test-wait.sh"

# Suites requiring a real agent session. Never silently passed over.
LIVE_SUITES="test-live-registration.sh"

FAILURES=0
TOTAL_EXECUTED=0
ZERO_TEST_FILES=""
RAN_SUITES=""
SKIPPED_LIVE=""
SKIPPED_SLOW=""

hr() { printf '%s\n' "------------------------------------------------------------"; }

step_fail() {
	FAILURES=$((FAILURES + 1))
	printf 'FAIL  %s\n' "$*"
}

# ==========================================================================
# The plan
# ==========================================================================

SUITES="$(find "$TEST_DIR" -maxdepth 1 -name 'test-*.sh' -type f 2>/dev/null | LC_ALL=C sort)"

if [ "$LIST" -eq 1 ]; then
	printf 'Gate steps: shellcheck (discovered), bash -n (syntax), unit suites\n\n'
	printf '%s\n' "$SUITES" | sed "s|^$TEST_DIR/|  |"
	exit 0
fi

# ==========================================================================
# BUILD-1 / BUILD-2 — static analysis, over DISCOVERED files
# ==========================================================================

hr
printf 'BUILD-1/2  shellcheck over every tracked shell script\n'
hr

# Discovery, not a hand-written glob (review finding R9): a glob silently
# excludes a file added later, and a gate that does not see a file is a gate
# that passes it.
# `ls-files` alone lists only TRACKED files, so a new, not-yet-added script was
# invisible to both static gates while the list stayed non-empty — the guard
# below could not fire, and BUILD-1/2 and BUILD-3 both reported PASS having
# never seen it. That is the same "a gate that does not see a file is a gate
# that passes it" trap this discovery step exists to close, one level out.
# `--cached` also lists TRACKED files that have been deleted from the working
# tree, and `bash -n` on a path that does not exist fails — reporting a syntax
# error for a file with no syntax. Every discovered path is filtered to one that
# actually exists, so the gate reports on what is there.
SHELL_FILES="$( (git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard '*.sh' 2>/dev/null || true) |
	grep -E '(goal-gate|prepare-goal|pursue-goal)/' | LC_ALL=C sort -u |
	while IFS= read -r f; do [ -f "$REPO_ROOT/$f" ] && printf '%s\n' "$f"; done || true)"

if [ -z "$SHELL_FILES" ]; then
	step_fail "shellcheck: no shell files were discovered — the gate would pass by seeing nothing"
elif ! command -v shellcheck >/dev/null 2>&1; then
	step_fail "shellcheck is not installed, so BUILD-1/2 could NOT run. A check that did not run is not a pass."
else
	SC_COUNT="$(printf '%s\n' "$SHELL_FILES" | wc -l | tr -d ' ')"
	printf 'discovered %s file(s)\n' "$SC_COUNT"
	SC_OUT=""
	SC_RC=0
	# shellcheck disable=SC2086  # deliberate word-splitting over the file list
	# NUL-delimited: xargs' default quote handling mangles backslashes and
	# quotes, and a path containing a space would split into two arguments.
	SC_OUT="$(cd "$REPO_ROOT" && printf '%s\n' "$SHELL_FILES" | tr '\n' '\0' | xargs -0 shellcheck 2>&1)" || SC_RC=$?
	if [ "$SC_RC" -eq 0 ]; then
		printf 'PASS  shellcheck clean across %s file(s)\n' "$SC_COUNT"
	else
		printf '%s\n' "$SC_OUT"
		step_fail "shellcheck reported findings"
	fi
fi

# ==========================================================================
# BUILD-3 — no compile step; a syntax gate stands in
# ==========================================================================

hr
printf 'BUILD-3    bash -n over every shipped script\n'
hr

SYNTAX_CHECKED=0
SYNTAX_BAD=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	SYNTAX_CHECKED=$((SYNTAX_CHECKED + 1))
	if ! bash -n "$REPO_ROOT/$f" 2>/dev/null; then
		printf 'FAIL  syntax: %s\n' "$f"
		SYNTAX_BAD=$((SYNTAX_BAD + 1))
	fi
done <<EOF
$SHELL_FILES
EOF

if [ "$SYNTAX_CHECKED" -eq 0 ]; then
	step_fail "the syntax gate checked NOTHING"
elif [ "$SYNTAX_BAD" -gt 0 ]; then
	step_fail "$SYNTAX_BAD file(s) failed the syntax gate"
else
	printf 'PASS  %s file(s) parse cleanly\n' "$SYNTAX_CHECKED"
fi

# ==========================================================================
# BUILD-4 — the unit suites, with per-file executed-test counts
# ==========================================================================

hr
printf 'BUILD-4    unit suites (sequential — they contend when parallel)\n'
hr

while IFS= read -r suite; do
	[ -n "$suite" ] || continue
	name="$(basename -- "$suite")"

	case " $LIVE_SUITES " in
	*" $name "*)
		if [ "${GOAL_GATE_LIVE-}" != "1" ]; then
			printf 'SKIPPED (live)  %s — needs a real agent session; run with GOAL_GATE_LIVE=1\n' "$name"
			SKIPPED_LIVE="$SKIPPED_LIVE $name"
			continue
		fi
		;;
	esac

	if [ "$QUICK" -eq 1 ]; then
		case " $SLOW_SUITES " in
		*" $name "*)
			printf 'SKIPPED (slow)  %s — --quick was given\n' "$name"
			SKIPPED_SLOW="$SKIPPED_SLOW $name"
			continue
			;;
		esac
	fi

	# stdin from /dev/null: this loop reads its worklist from a here-doc, and a
	# suite that reads stdin consumes the REST OF THE LIST. That is exactly what
	# happened — test-validate-acs.sh swallowed the remainder, so test-wait.sh
	# and its 65 assertions were never attempted, and the gate reported PASS.
	OUT="$(bash "$suite" </dev/null 2>&1)"
	RC=$?

	# The suites print `N passed, M failed`; that N is the executed-test count.
	# Two summary formats are in use across these suites:
	#   `N passed, M failed`   (optionally wrapped in `== ... ==`)
	#   `passed: N` / `failed: M`   on separate lines
	#
	# Both are read. Recognising only the first reported test-validate-acs.sh —
	# 131 real assertions — as "executed ZERO tests". A parser that manufactures
	# failures is the mirror image of one that hides them, and either way the
	# number the gate prints stops meaning what it says.
	SUMMARY="$(printf '%s\n' "$OUT" | grep -E '[0-9]+ passed, [0-9]+ failed' | tail -1)"
	if [ -n "$SUMMARY" ]; then
		PASSED="$(printf '%s' "$SUMMARY" | sed -E 's/.*[^0-9]([0-9]+) passed.*/\1/; s/^([0-9]+) passed.*/\1/')"
		FAILED="$(printf '%s' "$SUMMARY" | sed -E 's/.*, ([0-9]+) failed.*/\1/')"
	else
		PASSED="$(printf '%s\n' "$OUT" | sed -nE 's/^[[:space:]]*passed:[[:space:]]*([0-9]+).*/\1/p' | tail -1)"
		FAILED="$(printf '%s\n' "$OUT" | sed -nE 's/^[[:space:]]*failed:[[:space:]]*([0-9]+).*/\1/p' | tail -1)"
	fi
	case "$PASSED" in '' | *[!0-9]*) PASSED=0 ;; esac
	case "$FAILED" in '' | *[!0-9]*) FAILED=0 ;; esac
	TOTAL_EXECUTED=$((TOTAL_EXECUTED + PASSED + FAILED))

	if [ "$((PASSED + FAILED))" -eq 0 ]; then
		# Exiting 0 having executed nothing is the failure this counter exists
		# to catch: it reads as a pass at every level above this one.
		printf 'FAIL  %-34s executed ZERO tests (exit %s)\n' "$name" "$RC"
		ZERO_TEST_FILES="$ZERO_TEST_FILES $name"
		FAILURES=$((FAILURES + 1))
		continue
	fi

	RAN_SUITES="$RAN_SUITES $name"

	if [ "$RC" -eq 0 ] && [ "$FAILED" -eq 0 ]; then
		printf 'PASS  %-34s %s executed\n' "$name" "$((PASSED + FAILED))"
	else
		printf 'FAIL  %-34s %s executed, %s failed (exit %s)\n' "$name" "$((PASSED + FAILED))" "$FAILED" "$RC"
		printf '%s\n' "$OUT" | grep -E '^FAIL' | sed 's/^/        /'
		FAILURES=$((FAILURES + 1))
	fi
done <<EOF
$SUITES
EOF

# ==========================================================================
# Every suite tasks.md NAMES must exist and have executed tests
# ==========================================================================

hr
printf 'Coverage   every test file named in tasks.md\n'
hr

if [ ! -f "$TASKS" ]; then
	step_fail "tasks.md not found at $TASKS — the named-suite check could not run"
else
	NAMED="$(grep -oE '_bmad-output/eque2-code-goal-gate/tests/test-[a-z0-9-]+\.sh' "$TASKS" | LC_ALL=C sort -u)"
	MISSING=0
	NOT_RUN=0
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		n="$(basename -- "$rel")"
		if [ ! -f "$TEST_DIR/$n" ]; then
			printf 'FAIL  named in tasks.md but ABSENT: %s\n' "$n"
			MISSING=$((MISSING + 1))
			continue
		fi
		case " $SKIPPED_LIVE $SKIPPED_SLOW " in
		*" $n "*)
			printf 'SKIP  %s (reported above)\n' "$n"
			continue
			;;
		esac
		# ATTEMPTED, not merely "not known to have failed". The old check
		# asked whether a suite was in the zero-test or skipped lists — so a
		# suite that was never attempted at all appeared in neither and passed
		# silently. That is the same vacuity this gate exists to catch, in the
		# gate itself.
		case " $RAN_SUITES " in
		*" $n "*) : ;;
		*)
			printf 'FAIL  named in tasks.md but NEVER ATTEMPTED: %s\n' "$n"
			NOT_RUN=$((NOT_RUN + 1))
			continue
			;;
		esac
		case " $ZERO_TEST_FILES " in
		*" $n "*)
			NOT_RUN=$((NOT_RUN + 1))
			;;
		esac
	done <<EOF
$NAMED
EOF

	if [ "$MISSING" -gt 0 ]; then
		step_fail "$MISSING suite(s) named in tasks.md do not exist. A named-but-absent suite is a hole in the gate, not a smaller gate."
	elif [ "$NOT_RUN" -gt 0 ]; then
		step_fail "$NOT_RUN named suite(s) were never attempted or executed no tests"
	else
		printf 'PASS  every named suite exists and executed tests\n'
	fi
fi

# ==========================================================================
# Packaging — deliberately NOT checked here
# ==========================================================================
#
# The upstream gate verified a generated Claude/Codex plugin tree against the
# checkout. eque2-code does not ship one: distribution is the BMad marketplace,
# where `/eq2-build-marketplace` regenerates `skills/` from `_bmad-output/` and
# prunes anything stale, so the drift this step guarded against cannot arise.
# The check is removed rather than left to print "nothing to verify" forever —
# a step that can only ever pass is not a check, and reads as one.

# ==========================================================================
# The decoy, and the pass-through guard
# ==========================================================================

hr
printf 'Discipline the decoy and the pass-through guard\n'
hr

# The decoy is not invoked by any gate step. Asserted by inspecting this file,
# so the claim cannot drift away from the code that makes it true.
# Comment lines are stripped first: this file DISCUSSES the decoy at length,
# and matching its own prose would report a defect that is not there.
if grep -vE '^[[:space:]]*#' "$TEST_DIR/run-all.sh" | grep -qE 'npm (run )?test'; then
	step_fail "a gate step invokes the npm decoy"
else
	printf 'PASS  the npm decoy is never invoked\n'
fi

PYGUARD="$SKILL_DIR/../eque2-code-prepare-goal/scripts/tests/test-detect-quality-gate.py"
if [ -f "$PYGUARD" ]; then
	printf 'NOTE  pass-through regression guard: %s\n' "$(basename -- "$PYGUARD")"
	printf '      No task in this feature changes that code, so it is run for\n'
	printf '      regression only and is NOT evidence for this feature.\n'
	if command -v python3 >/dev/null 2>&1; then
		if python3 "$PYGUARD" >/dev/null 2>&1; then
			printf 'PASS  (pass-through) %s\n' "$(basename -- "$PYGUARD")"
		else
			step_fail "(pass-through) the Python regression guard failed"
		fi
	else
		# The same policy shellcheck gets twenty lines up: a check that did not
		# run is not a pass. Silently omitting it was this file contradicting
		# itself within one screen.
		step_fail "python3 is not installed, so the pass-through regression guard could NOT run. A check that did not run is not a pass."
	fi
else
	step_fail "the pass-through regression guard is MISSING at $PYGUARD. A file that is named but absent is a hole in the gate, not a smaller gate."
fi

# ==========================================================================
# Summary
# ==========================================================================

hr
printf 'Executed %s tests across the unit suites.\n' "$TOTAL_EXECUTED"
[ -n "$SKIPPED_LIVE" ] && printf 'SKIPPED (live):%s — graded from transcript evidence, NOT from this suite.\n' "$SKIPPED_LIVE"
[ -n "$SKIPPED_SLOW" ] && printf 'SKIPPED (slow):%s — --quick was given; the gate is NOT complete.\n' "$SKIPPED_SLOW"

if [ "$TOTAL_EXECUTED" -eq 0 ]; then
	step_fail "the gate executed NO tests at all"
fi

if [ "$FAILURES" -eq 0 ] && [ "$QUICK" -eq 0 ]; then
	printf '\nGATE PASSED\n'
	exit 0
fi

if [ "$FAILURES" -eq 0 ]; then
	# Exit 2, NOT 0. A CI wrapper reading only $? cannot otherwise tell a
	# partial run from a complete one, and "the gate is NOT complete" printed
	# above a zero exit is a caveat nothing machine-readable ever sees.
	printf '\nGATE INCOMPLETE — every step that RAN passed, but %s did not run. Exit 2 (not 0): this is not a full gate.\n' "${SKIPPED_SLOW# }"
	exit 2
fi

printf '\nGATE FAILED — %s step(s)\n' "$FAILURES"
exit 1
