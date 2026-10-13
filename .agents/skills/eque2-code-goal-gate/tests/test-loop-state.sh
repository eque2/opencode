#!/usr/bin/env bash
# test-loop-state.sh — executable conformance suite for loop-state.sh, the
# goal-gate loop file's state read/write module.
#
# Covers all seven required test-case classes: happy path, invalid input,
# boundary, empty/null, concurrency, error propagation, resource limits.
#
# The suite exists chiefly to hold the line against four inherited defects in
# the predecessor hook (~/.claude/hooks/the predecessor stop hook):
#
#   D2  command substitution from state content — `$(...)` in a value must
#       round-trip as literal text and must never be evaluated.
#   D5  escaping failures on shell metacharacters.
#   D9  a fixed `.tmp` path, so two concurrent writers corrupted the file.
#   D11 an unanchored field match, so field `iter` matched `iteration`.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MODULE="${LOOP_STATE_MODULE:-${TEST_DIR}/../loop-state.sh}"

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

# ls_run <args...> — invoke the module's CLI, capturing stdout only.
ls_run() {
	bash "$MODULE" "$@" 2>/dev/null
}

# assert_fails <name> <expected-exit> <cli args...>
assert_fails() {
	local name="$1" expected="$2"
	shift 2
	local out status
	out="$(bash "$MODULE" "$@" 2>&1)"
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
	*loop-state:*) pass "$name" ;;
	*) fail "$name" "exit $status correct but no 'loop-state:' diagnostic: [$out]" ;;
	esac
}

# assert_roundtrip <name> <file> <field> <value>
#
# Writes a value, reads it back BYTE-EXACTLY via files (never via command
# substitution, which would silently eat trailing newlines) and diffs.
assert_roundtrip() {
	local name="$1" file="$2" field="$3" value="$4"

	if ! bash "$MODULE" set "$file" "$field" "$value" 2>/dev/null; then
		fail "$name" "set failed"
		return
	fi

	local expected_f actual_f
	expected_f="$WORK_DIR/expected.$$"
	actual_f="$WORK_DIR/actual.$$"
	printf '%s' "$value" >"$expected_f"
	if ! bash "$MODULE" get --raw "$file" "$field" >"$actual_f" 2>/dev/null; then
		fail "$name" "get failed"
		rm -f -- "$expected_f" "$actual_f"
		return
	fi

	if cmp -s "$expected_f" "$actual_f"; then
		pass "$name"
	else
		fail "$name" "round-trip differs: expected $(wc -c <"$expected_f" | tr -d ' ') bytes, got $(wc -c <"$actual_f" | tr -d ' ') bytes"
	fi
	rm -f -- "$expected_f" "$actual_f"
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

if [ ! -f "$MODULE" ]; then
	printf 'FAIL  module-present\n        no loop-state module at %s\n' "$MODULE"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "module-present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loop-state-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"

# --------------------------------------------------------------------------
# 1. Happy path — round-trip write->read of every field
# --------------------------------------------------------------------------

HAPPY="$ROOT/happy.state"

assert_roundtrip "happy/status" "$HAPPY" "status" "running"
assert_roundtrip "happy/iteration" "$HAPPY" "iteration" "7"
assert_roundtrip "happy/last_failure_hash" "$HAPPY" "last_failure_hash" \
	"9f2c1ab77e4d0f3b8c5a6e1d2f4b9c8a7e6d5c4b3a29180f7e6d5c4b3a291807"
assert_roundtrip "happy/binding_identity" "$HAPPY" "binding_identity" \
	"session-2f8c41ae-9b3d-4e77-a1c0-5d6e7f8a9b0c"
assert_roundtrip "happy/history" "$HAPPY" "history" \
	"$(printf 'iter 1: 3 red\niter 2: 2 red\niter 3: 0 red')"

# Every field survives ALL the others being written — a later set must not
# disturb an earlier one.
assert_equals "happy/status-survives-later-writes" "running" "$(ls_run get "$HAPPY" status)"
assert_equals "happy/iteration-survives-later-writes" "7" "$(ls_run get "$HAPPY" iteration)"
assert_equals "happy/binding-survives-later-writes" \
	"session-2f8c41ae-9b3d-4e77-a1c0-5d6e7f8a9b0c" \
	"$(ls_run get "$HAPPY" binding_identity)"

# Overwrite in place: the field updates and the file does not grow a duplicate.
bash "$MODULE" set "$HAPPY" status "stalled" 2>/dev/null
assert_equals "happy/overwrite-updates" "stalled" "$(ls_run get "$HAPPY" status)"
assert_equals "happy/overwrite-leaves-one-line" "1" \
	"$(grep -c '^status=' "$HAPPY")"
assert_equals "happy/overwrite-preserves-others" "7" "$(ls_run get "$HAPPY" iteration)"

# The stored form stays human-readable and line-oriented.
assert_equals "happy/one-line-per-field" "5" "$(wc -l <"$HAPPY" | tr -d ' ')"

# Values ending in a newline survive --raw byte-exactly (the reason --raw
# exists: command substitution would eat the terminator).
assert_roundtrip "happy/trailing-newline-exact" "$HAPPY" "history" \
	"$(printf 'a\nb\n\n')"$'\n'

# --------------------------------------------------------------------------
# 2. Invalid input — hostile values round-trip intact and are NEVER interpreted
#    (ancestor defects D5 and D2)
# --------------------------------------------------------------------------

HOSTILE="$ROOT/hostile.state"

assert_roundtrip "hostile/pipe" "$HOSTILE" "v" 'a|b|c'
assert_roundtrip "hostile/ampersand" "$HOSTILE" "v" 'a & b && c'
# shellcheck disable=SC1003  # literal backslashes are the point of this test
assert_roundtrip "hostile/backslash" "$HOSTILE" "v" 'a\b\\c\'
assert_roundtrip "hostile/single-quote" "$HOSTILE" "v" "it's a 'quoted' thing"
assert_roundtrip "hostile/double-quote" "$HOSTILE" "v" 'he said "no" loudly'
assert_roundtrip "hostile/newlines" "$HOSTILE" "v" "$(printf 'line1\nline2\nline3')"
assert_roundtrip "hostile/carriage-return" "$HOSTILE" "v" "$(printf 'crlf\r\nline')"
assert_roundtrip "hostile/semicolons-and-redirects" "$HOSTILE" "v" 'x; rm -rf /tmp/nope > /dev/null'
# shellcheck disable=SC2016  # the value must stay unexpanded
assert_roundtrip "hostile/backticks" "$HOSTILE" "v" 'value with `backticks` inside'
# shellcheck disable=SC2016  # the value must stay unexpanded
assert_roundtrip "hostile/dollar-brace" "$HOSTILE" "v" 'literal ${HOME} and $PATH'
assert_roundtrip "hostile/glob" "$HOSTILE" "v" '* ? [a-z] {a,b}'
assert_roundtrip "hostile/percent-and-printf" "$HOSTILE" "v" '%s %d %% \n \t'
assert_roundtrip "hostile/equals-in-value" "$HOSTILE" "v" 'a=b=c=d'
assert_roundtrip "hostile/leading-trailing-space" "$HOSTILE" "v" '   padded   '
assert_roundtrip "hostile/unicode" "$HOSTILE" "v" 'ok — naïve ✓ 日本語'

# The escaped forms themselves, written as LITERAL text, must not be decoded
# into the characters they stand for.
assert_roundtrip "hostile/literal-backslash-n" "$HOSTILE" "v" 'not a newline: \n'
assert_roundtrip "hostile/literal-backslash-r" "$HOSTILE" "v" 'not a return: \r'
assert_roundtrip "hostile/literal-double-backslash" "$HOSTILE" "v" 'two slashes: \\n'
# shellcheck disable=SC1003  # literal backslashes are the point of this test
assert_roundtrip "hostile/escape-soup" "$HOSTILE" "v" '\\\n\\\\r\n\\'

# --- D2: command substitution from state content --------------------------
#
# The payload writes a canary file if it is ever evaluated. Round-tripping it
# must leave the canary absent.
CANARY="$ROOT/canary-EVALUATED"
# shellcheck disable=SC2016  # must stay a literal, unexpanded substitution
PAYLOAD='$(touch '"$CANARY"')'
assert_roundtrip "D2/command-substitution-roundtrips-literally" "$HOSTILE" "danger" "$PAYLOAD"
if [ -e "$CANARY" ]; then
	fail "D2/command-substitution-not-executed" "canary exists: the value was EVALUATED"
	rm -f -- "$CANARY"
else
	pass "D2/command-substitution-not-executed"
fi

CANARY2="$ROOT/canary-BACKTICK"
PAYLOAD2='`touch '"$CANARY2"'`'
assert_roundtrip "D2/backtick-substitution-roundtrips-literally" "$HOSTILE" "danger2" "$PAYLOAD2"
if [ -e "$CANARY2" ]; then
	fail "D2/backtick-substitution-not-executed" "canary exists: the value was EVALUATED"
	rm -f -- "$CANARY2"
else
	pass "D2/backtick-substitution-not-executed"
fi

# The classic: a destructive substitution embedded in a multi-line history.
CANARY3="$ROOT/canary-HISTORY"
# shellcheck disable=SC2016  # the embedded substitution must stay unexpanded
assert_roundtrip "D2/substitution-inside-multiline-history" "$HOSTILE" "history" \
	"$(printf 'iter 1: failed\niter 2: $(touch %s)\niter 3: still failed' "$CANARY3")"
if [ -e "$CANARY3" ]; then
	fail "D2/multiline-substitution-not-executed" "canary exists: the value was EVALUATED"
	rm -f -- "$CANARY3"
else
	pass "D2/multiline-substitution-not-executed"
fi

# Invalid field names are rejected outright rather than producing a mangled file.
assert_fails "invalid/empty-field-name" 2 get "$HOSTILE" ""
assert_fails "invalid/field-name-with-equals" 2 get "$HOSTILE" "a=b"
assert_fails "invalid/field-name-with-space" 2 set "$HOSTILE" "a b" "x"
assert_fails "invalid/field-name-leading-digit" 2 set "$HOSTILE" "1st" "x"
assert_fails "invalid/field-name-with-newline" 2 set "$HOSTILE" "$(printf 'a\nb')" "x"
assert_fails "invalid/empty-state-path" 2 get "" "status"
assert_fails "invalid/unknown-verb" 64 frobnicate "$HOSTILE" "status"
assert_fails "invalid/no-verb" 64
assert_fails "invalid/get-too-few-args" 64 get "$HOSTILE"
assert_fails "invalid/set-too-few-args" 64 set "$HOSTILE" "status"
assert_fails "invalid/set-too-many-args" 64 set "$HOSTILE" "status" "a" "b"

# --------------------------------------------------------------------------
# 3. Boundary — absent field, doubled field, prefix-named field (D11)
# --------------------------------------------------------------------------

BOUND="$ROOT/boundary.state"
bash "$MODULE" set "$BOUND" status "running" 2>/dev/null

# Absent field: exit 1, no output, no silent default.
absent_out="$(bash "$MODULE" get "$BOUND" nosuchfield 2>/dev/null)"
absent_status=$?
assert_equals "boundary/absent-field-exit-1" "1" "$absent_status"
assert_equals "boundary/absent-field-no-output" "" "$absent_out"

# An absent field is distinguishable from a present-but-empty one.
bash "$MODULE" set "$BOUND" empty_field "" 2>/dev/null
empty_out="$(bash "$MODULE" get --raw "$BOUND" empty_field 2>/dev/null)"
empty_status=$?
assert_equals "boundary/empty-value-exit-0" "0" "$empty_status"
assert_equals "boundary/empty-value-is-empty" "" "$empty_out"

# --- D11: an unanchored match let `iter` match `iteration` ----------------
#
# Field names that are prefixes/suffixes/substrings of each other must be
# completely independent.
PREFIX="$ROOT/prefix.state"
bash "$MODULE" set "$PREFIX" iteration "100" 2>/dev/null
bash "$MODULE" set "$PREFIX" iter "5" 2>/dev/null
bash "$MODULE" set "$PREFIX" iteration_limit "999" 2>/dev/null
bash "$MODULE" set "$PREFIX" it "1" 2>/dev/null

assert_equals "D11/short-name-not-shadowed" "5" "$(ls_run get "$PREFIX" iter)"
assert_equals "D11/long-name-not-shadowed" "100" "$(ls_run get "$PREFIX" iteration)"
assert_equals "D11/suffixed-name-independent" "999" "$(ls_run get "$PREFIX" iteration_limit)"
assert_equals "D11/shortest-name-independent" "1" "$(ls_run get "$PREFIX" it)"

# Writing the SHORT name must not rewrite the long one (the ancestor's sed
# `s|^iter:.*|` clobbered `iteration:` wholesale).
bash "$MODULE" set "$PREFIX" iter "6" 2>/dev/null
assert_equals "D11/short-write-leaves-long-intact" "100" "$(ls_run get "$PREFIX" iteration)"
assert_equals "D11/short-write-leaves-suffixed-intact" "999" "$(ls_run get "$PREFIX" iteration_limit)"
assert_equals "D11/short-write-applied" "6" "$(ls_run get "$PREFIX" iter)"

# A value that LOOKS like another field's line must not be read as one.
bash "$MODULE" set "$PREFIX" note "$(printf 'iteration=666')" 2>/dev/null
assert_equals "D11/value-resembling-a-field-line-is-inert" "100" \
	"$(ls_run get "$PREFIX" iteration)"
assert_equals "D11/value-resembling-a-field-line-roundtrips" "iteration=666" \
	"$(ls_run get "$PREFIX" note)"

# A value containing an ESCAPED newline followed by a field-shaped line must
# likewise not inject a field — this is the injection the escaping exists for.
bash "$MODULE" set "$PREFIX" note2 "$(printf 'x\niteration=777')" 2>/dev/null
assert_equals "D11/newline-injection-does-not-create-a-field" "100" \
	"$(ls_run get "$PREFIX" iteration)"
assert_equals "D11/newline-injection-file-line-count" "6" \
	"$(wc -l <"$PREFIX" | tr -d ' ')"

# A field appearing TWICE is corruption, not a silent last-wins.
DUP="$ROOT/dup.state"
printf 'status=running\niteration=3\nstatus=stalled\n' >"$DUP"
assert_fails "boundary/duplicate-field-is-corrupt" 6 get "$DUP" status
# ...but an unaffected field is still readable.
assert_equals "boundary/duplicate-does-not-poison-other-fields" "3" \
	"$(ls_run get "$DUP" iteration)"
# A write over a duplicated field collapses it back to one line rather than
# preserving the ambiguity.
if bash "$MODULE" set "$DUP" status "fresh" 2>/dev/null; then
	assert_equals "boundary/write-collapses-duplicate" "fresh" "$(ls_run get "$DUP" status)"
	assert_equals "boundary/write-collapses-duplicate-count" "1" "$(grep -c '^status=' "$DUP")"
else
	fail "boundary/write-collapses-duplicate" "set over a duplicated field failed outright"
fi

# Structurally malformed lines are corruption, never quietly skipped.
MALFORMED="$ROOT/malformed.state"
printf 'status=running\nthis line has no equals sign\n' >"$MALFORMED"
assert_fails "boundary/line-without-equals-is-corrupt" 6 get "$MALFORMED" status

BADNAME="$ROOT/badname.state"
printf 'status=running\nbad name=x\n' >"$BADNAME"
assert_fails "boundary/invalid-field-name-in-file-is-corrupt" 6 get "$BADNAME" status

BADESCAPE="$ROOT/badescape.state"
printf 'status=oops\\q\n' >"$BADESCAPE"
assert_fails "boundary/unknown-escape-is-corrupt" 6 get "$BADESCAPE" status

DANGLING="$ROOT/dangling.state"
printf 'status=trailing\\\n' >"$DANGLING"
assert_fails "boundary/dangling-escape-is-corrupt" 6 get "$DANGLING" status

# A final line with no trailing newline is still read.
NONEWLINE="$ROOT/nonewline.state"
printf 'status=running\niteration=42' >"$NONEWLINE"
assert_equals "boundary/final-line-without-newline" "42" "$(ls_run get "$NONEWLINE" iteration)"

# --------------------------------------------------------------------------
# 4. Empty / null — empty file, missing file
# --------------------------------------------------------------------------

EMPTY="$ROOT/empty.state"
: >"$EMPTY"
empty_file_out="$(bash "$MODULE" get "$EMPTY" status 2>/dev/null)"
empty_file_status=$?
assert_equals "empty/empty-file-field-absent" "1" "$empty_file_status"
assert_equals "empty/empty-file-no-output" "" "$empty_file_out"

# Writing into an empty file works and yields exactly one line.
bash "$MODULE" set "$EMPTY" status "running" 2>/dev/null
assert_equals "empty/write-into-empty-file" "running" "$(ls_run get "$EMPTY" status)"
assert_equals "empty/write-into-empty-file-line-count" "1" "$(wc -l <"$EMPTY" | tr -d ' ')"

# Missing file: an explicit error, NOT an empty value.
assert_fails "empty/missing-file-is-an-error" 3 get "$ROOT/does-not-exist.state" status

# Missing file on write: created from scratch.
CREATED="$ROOT/created.state"
bash "$MODULE" set "$CREATED" status "fresh" 2>/dev/null
assert_equals "empty/set-creates-missing-file" "fresh" "$(ls_run get "$CREATED" status)"

# A directory where the state file should be is an error, not an empty read.
mkdir -p "$ROOT/adirectory.state"
assert_fails "empty/directory-instead-of-file" 3 get "$ROOT/adirectory.state" status

# --------------------------------------------------------------------------
# 5. Concurrency — REAL racing writers must not corrupt the file (D9)
# --------------------------------------------------------------------------

# --- D9: the temp file must be uniquely named, not a fixed `.tmp` ---------
#
# Asserted structurally as well as behaviourally: a fixed sibling `.tmp` path is
# exactly what let two writers stomp each other in the ancestor.
# shellcheck disable=SC2016  # a regex, not an expansion
if grep -qE '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.tmp|"\$file"\.tmp|\.tmp"' "$MODULE"; then
	fail "D9/no-fixed-tmp-path" "module still references a fixed .tmp path"
else
	pass "D9/no-fixed-tmp-path"
fi
if grep -q 'mktemp' "$MODULE"; then
	pass "D9/uses-mktemp"
else
	fail "D9/uses-mktemp" "module does not use mktemp"
fi

CONC="$ROOT/concurrent.state"
bash "$MODULE" set "$CONC" seed "initial" 2>/dev/null

WRITERS=12
pids=()
for i in $(seq 1 "$WRITERS"); do
	(
		bash "$MODULE" set "$CONC" "writer_$i" "value-$i-$(printf 'x%.0s' $(seq 1 200))" 2>/dev/null
	) &
	pids+=("$!")
done
conc_writer_failures=0
for p in "${pids[@]}"; do
	wait "$p" || conc_writer_failures=$((conc_writer_failures + 1))
done
assert_equals "concurrency/all-writers-succeeded" "0" "$conc_writer_failures"

# The file must still parse — no interleaved/truncated garbage.
if bash "$MODULE" get "$CONC" seed >/dev/null 2>&1; then
	pass "concurrency/file-still-parses"
else
	fail "concurrency/file-still-parses" "state file unreadable after $WRITERS concurrent writers"
fi
assert_equals "concurrency/pre-existing-field-intact" "initial" "$(ls_run get "$CONC" seed)"

# Every writer's update must have survived: an atomic rename alone prevents
# corruption but not LOST UPDATES, which the writer lock exists to stop.
conc_missing=0
conc_wrong=0
for i in $(seq 1 "$WRITERS"); do
	got="$(bash "$MODULE" get "$CONC" "writer_$i" 2>/dev/null)" || {
		conc_missing=$((conc_missing + 1))
		continue
	}
	case "$got" in
	"value-$i-"*) : ;;
	*) conc_wrong=$((conc_wrong + 1)) ;;
	esac
done
assert_equals "concurrency/no-lost-updates" "0" "$conc_missing"
assert_equals "concurrency/no-mangled-values" "0" "$conc_wrong"

# No temp or lock debris left behind.
debris="$(find "$ROOT" -maxdepth 1 -name '.loop-state.*' | wc -l | tr -d ' ')"
assert_equals "concurrency/no-temp-file-debris" "0" "$debris"
lockdebris="$(find "$ROOT" -maxdepth 1 -name '*.lock' | wc -l | tr -d ' ')"
assert_equals "concurrency/no-lock-debris" "0" "$lockdebris"

# Racing writers on the SAME field: the winner must be one of the values
# written, never a blend of two.
SAMEFIELD="$ROOT/samefield.state"
bash "$MODULE" set "$SAMEFIELD" contended "start" 2>/dev/null
pids=()
for i in $(seq 1 8); do
	(bash "$MODULE" set "$SAMEFIELD" contended "candidate-$i" 2>/dev/null) &
	pids+=("$!")
done
for p in "${pids[@]}"; do wait "$p" || true; done
same_out="$(bash "$MODULE" get "$SAMEFIELD" contended 2>/dev/null)"
case "$same_out" in
candidate-[1-8]) pass "concurrency/same-field-winner-is-whole" ;;
*) fail "concurrency/same-field-winner-is-whole" "blended or corrupt value: [$same_out]" ;;
esac
assert_equals "concurrency/same-field-single-line" "1" "$(grep -c '^contended=' "$SAMEFIELD")"

# --------------------------------------------------------------------------
# 6. Error propagation — an interrupted write leaves the PREVIOUS state
#    readable, never a truncated file
# --------------------------------------------------------------------------

KILLED="$ROOT/killed.state"
PREV="previous-value-that-must-survive"
bash "$MODULE" set "$KILLED" status "$PREV" 2>/dev/null

# A large replacement value, so the write has a real window to be killed in.
BIG_VALUE="$(printf 'y%.0s' $(seq 1 40000))"

interrupt_bad=0
interrupt_truncated=0
for attempt in $(seq 1 12); do
	(bash "$MODULE" set "$KILLED" status "$BIG_VALUE" 2>/dev/null) &
	victim=$!
	# Kill during the write window, at a varying offset so different phases of
	# the write get interrupted across attempts.
	sleep "0.00$attempt"
	kill -9 "$victim" 2>/dev/null || true
	wait "$victim" 2>/dev/null || true

	# A killed writer may leave the lock dir behind; a reader never needs it,
	# and clearing it is the documented manual remedy.
	rm -rf -- "$KILLED.lock"

	got="$(bash "$MODULE" get "$KILLED" status 2>/dev/null)" || {
		interrupt_truncated=$((interrupt_truncated + 1))
		continue
	}
	if [ "$got" != "$PREV" ] && [ "$got" != "$BIG_VALUE" ]; then
		interrupt_bad=$((interrupt_bad + 1))
	fi
done

assert_equals "error/interrupted-write-never-unreadable" "0" "$interrupt_truncated"
assert_equals "error/interrupted-write-is-all-or-nothing" "0" "$interrupt_bad"

# Whatever landed, the file is one field on one line — never a half-written one.
assert_equals "error/interrupted-write-no-partial-line" "1" "$(grep -c '^status=' "$KILLED")"
assert_equals "error/interrupted-write-single-line-file" "1" "$(wc -l <"$KILLED" | tr -d ' ')"

# Temp files from killed writers must not be readable as state.
if bash "$MODULE" get "$KILLED" status >/dev/null 2>&1; then
	pass "error/state-readable-after-all-interruptions"
else
	fail "error/state-readable-after-all-interruptions" "state unreadable after interrupted writes"
fi

# An unwritable directory propagates as an explicit failure, and the previous
# state is left untouched.
mkdir -p "$ROOT/locked"
bash "$MODULE" set "$ROOT/locked/s.state" status "before-lock" 2>/dev/null
chmod a-w "$ROOT/locked"
if [ -w "$ROOT/locked" ]; then
	fail "error/unwritable-directory-propagates" \
		"precondition unmet: $ROOT/locked still writable (running as root?)"
else
	assert_fails "error/unwritable-directory-propagates" 5 \
		set "$ROOT/locked/s.state" status "after-lock"
	assert_equals "error/failed-write-leaves-state-intact" "before-lock" \
		"$(ls_run get "$ROOT/locked/s.state" status)"
fi
chmod u+w "$ROOT/locked"

# --- A FAILED write must release the writer lock -------------------------
#
# Regression: set_locked's error returns ran under `set -e`, so the shell exited
# before the unlock — leaking the lock dir. One corrupt write then poisoned every
# subsequent write, each stalling for the whole retry budget before failing 5.
# A failure must stay local to the write that caused it.

LEAK="$ROOT/leak.state"
printf 'status=running\nthis line has no equals sign\n' >"$LEAK"
assert_fails "error/corrupt-write-refused" 6 set "$LEAK" status "x"

if [ -e "$LEAK.lock" ]; then
	fail "error/failed-write-releases-lock" "lock dir survived a failed write: $LEAK.lock"
	rm -rf -- "$LEAK.lock"
else
	pass "error/failed-write-releases-lock"
fi

# ...and the very next write, once the corruption is cleared, succeeds promptly
# rather than blocking on a stale lock.
: >"$LEAK"
leak_start="$(date +%s)"
if bash "$MODULE" set "$LEAK" status "recovered" 2>/dev/null; then
	pass "error/write-after-failed-write-succeeds"
else
	fail "error/write-after-failed-write-succeeds" "a later write failed after an earlier one errored"
fi
leak_elapsed=$(($(date +%s) - leak_start))
if [ "$leak_elapsed" -le 2 ]; then
	pass "error/write-after-failed-write-is-prompt (${leak_elapsed}s)"
else
	fail "error/write-after-failed-write-is-prompt" \
		"took ${leak_elapsed}s — a stale lock is being waited out"
fi
assert_equals "error/recovered-value-readable" "recovered" "$(ls_run get "$LEAK" status)"

# The same must hold for a write that fails on a filesystem error rather than
# corruption: no lock left behind.
mkdir -p "$ROOT/nolock"
bash "$MODULE" set "$ROOT/nolock/s.state" status "seed" 2>/dev/null
chmod a-w "$ROOT/nolock"
bash "$MODULE" set "$ROOT/nolock/s.state" status "nope" >/dev/null 2>&1
chmod u+w "$ROOT/nolock"
if [ -e "$ROOT/nolock/s.state.lock" ]; then
	fail "error/fs-failure-releases-lock" "lock dir survived a filesystem-failed write"
	rm -rf -- "$ROOT/nolock/s.state.lock"
else
	pass "error/fs-failure-releases-lock"
fi

# An unreadable state file is an explicit error, not an empty read.
UNREADABLE="$ROOT/unreadable.state"
bash "$MODULE" set "$UNREADABLE" status "secret" 2>/dev/null
chmod a-r "$UNREADABLE"
if [ -r "$UNREADABLE" ]; then
	fail "error/unreadable-file-propagates" \
		"precondition unmet: $UNREADABLE still readable (running as root?)"
else
	assert_fails "error/unreadable-file-propagates" 3 get "$UNREADABLE" status
fi
chmod u+r "$UNREADABLE"

# --------------------------------------------------------------------------
# 7. Resource limits — a large history must not degrade the read past a bound
# --------------------------------------------------------------------------

BIG="$ROOT/big.state"

HISTORY_LINES=4000
BIG_HISTORY="$(seq 1 "$HISTORY_LINES" | sed 's/^/iteration & : 3 criteria red | hash=deadbeef/')"

big_write_start="$(date +%s)"
if bash "$MODULE" set "$BIG" history "$BIG_HISTORY" 2>/dev/null; then
	pass "limits/large-history-writes"
else
	fail "limits/large-history-writes" "set failed for a ${HISTORY_LINES}-line history"
fi
big_write_elapsed=$(($(date +%s) - big_write_start))

# The whole history must be on ONE line — newlines are escaped, not literal.
assert_equals "limits/large-history-is-one-line" "1" "$(wc -l <"$BIG" | tr -d ' ')"

big_read_start="$(date +%s)"
big_out_f="$ROOT/big.out"
if bash "$MODULE" get --raw "$BIG" history >"$big_out_f" 2>/dev/null; then
	pass "limits/large-history-reads"
else
	fail "limits/large-history-reads" "get failed for a ${HISTORY_LINES}-line history"
fi
big_read_elapsed=$(($(date +%s) - big_read_start))

# Byte-exact round-trip at size.
big_expect_f="$ROOT/big.expect"
printf '%s' "$BIG_HISTORY" >"$big_expect_f"
if cmp -s "$big_expect_f" "$big_out_f"; then
	pass "limits/large-history-roundtrips-exactly"
else
	fail "limits/large-history-roundtrips-exactly" \
		"expected $(wc -c <"$big_expect_f" | tr -d ' ') bytes, got $(wc -c <"$big_out_f" | tr -d ' ') bytes"
fi

LIMIT_SECONDS=10
if [ "$big_read_elapsed" -le "$LIMIT_SECONDS" ]; then
	pass "limits/large-history-read-within-${LIMIT_SECONDS}s (${big_read_elapsed}s)"
else
	fail "limits/large-history-read-within-${LIMIT_SECONDS}s" \
		"read took ${big_read_elapsed}s for ${HISTORY_LINES} history lines"
fi
if [ "$big_write_elapsed" -le "$LIMIT_SECONDS" ]; then
	pass "limits/large-history-write-within-${LIMIT_SECONDS}s (${big_write_elapsed}s)"
else
	fail "limits/large-history-write-within-${LIMIT_SECONDS}s" \
		"write took ${big_write_elapsed}s for ${HISTORY_LINES} history lines"
fi

# Other fields stay cheap to read alongside a huge one.
bash "$MODULE" set "$BIG" iteration "4321" 2>/dev/null
assert_equals "limits/small-field-beside-large-history" "4321" "$(ls_run get "$BIG" iteration)"
assert_equals "limits/large-history-survives-sibling-write" "$(printf '%s' "$BIG_HISTORY" | wc -c | tr -d ' ')" \
	"$(bash "$MODULE" get --raw "$BIG" history 2>/dev/null | wc -c | tr -d ' ')"

# A very long single-line value (no escapes) also round-trips.
LONG_LINE="$(printf 'z%.0s' $(seq 1 100000))"
assert_roundtrip "limits/very-long-single-line-value" "$BIG" "blob" "$LONG_LINE"

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
