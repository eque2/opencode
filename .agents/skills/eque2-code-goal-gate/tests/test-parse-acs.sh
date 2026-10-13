#!/usr/bin/env bash
# test-parse-acs.sh — executable conformance suite for parse-acs.sh, the single
# source of verdict truth for ACs.md.
#
# Contract: .claude/skills/prepare-goal/references/acs-format.md
#
# Exercises every required class: happy path, invalid input, boundary,
# empty/null, error propagation, security boundaries, concurrency and timing —
# with the governing defect class front and centre: an unknown, a dropped
# criterion, or an excluded-looking line must NEVER resolve to "met".
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# PARSER override (for the non-vacuity mutation check only):
#   PARSE_ACS=/path/to/mutant.sh bash test-parse-acs.sh

# shellcheck disable=SC2016
# Backticks throughout this file are LITERAL ACs.md markup inside fixture text
# (a criterion must name its specified system in backticks), never command
# substitution. Single quotes are therefore correct and deliberate.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PARSER="${PARSE_ACS:-${TEST_DIR}/../parse-acs.sh}"

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

# run_parser <args...> — sets RUN_OUT (stdout), RUN_ERR (stderr), RUN_STATUS.
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
run_parser() {
	local errfile
	errfile="$(mktemp "${TMPDIR:-/tmp}/parse-acs-err.XXXXXX")"
	RUN_OUT="$(bash "$PARSER" "$@" 2>"$errfile")"
	RUN_STATUS=$?
	RUN_ERR="$(cat -- "$errfile")"
	rm -f -- "$errfile"
}

# assert_exit <name> <expected-exit> <args...>
assert_exit() {
	local name="$1" expected="$2"
	shift 2
	run_parser "$@"
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
#   2. a `parse-acs:` diagnostic on stderr (no silent failure path), and
#   3. EMPTY STDOUT.
#
# (3) is the load-bearing property of this script: counts appear only on a
# trustworthy parse, so a consumer can never read `unchecked=0` off an error
# path and conclude the work is done.
assert_refused() {
	local name="$1" expected="$2"
	shift 2
	run_parser "$@"
	if [ "$RUN_STATUS" -eq 0 ]; then
		fail "$name" "expected refusal (exit $expected) but succeeded with [$RUN_OUT]"
		return
	fi
	if [ "$RUN_STATUS" -ne "$expected" ]; then
		fail "$name" "expected exit $expected, got $RUN_STATUS (err=[$RUN_ERR])"
		return
	fi
	case "$RUN_ERR" in
	*parse-acs:*) : ;;
	*)
		fail "$name" "exit $RUN_STATUS correct but no 'parse-acs:' diagnostic: [$RUN_ERR]"
		return
		;;
	esac
	if [ -n "$RUN_OUT" ]; then
		fail "$name" "refusal leaked counts to stdout: [$RUN_OUT]"
		return
	fi
	pass "$name"
}

# assert_count <name> <key> <expected> <args...>
assert_count() {
	local name="$1" key="$2" expected="$3"
	shift 3
	run_parser "$@"
	if [ "$RUN_STATUS" -gt 1 ]; then
		fail "$name" "expected a parse (exit 0 or 1), got $RUN_STATUS (err=[$RUN_ERR])"
		return
	fi
	assert_equals "$name" "$expected" "$(printf '%s\n' "$RUN_OUT" | sed -n "s/^${key}=//p")"
}

# assert_verdict <name> <done|not_done> <expected-exit> <args...>
assert_verdict() {
	local name="$1" want="$2" expected="$3" got
	shift 3
	run_parser "$@"
	got="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^verdict=//p')"
	if [ "$got" != "$want" ]; then
		fail "$name" "expected verdict=$want, got [$got] (exit $RUN_STATUS, err=[$RUN_ERR])"
		return
	fi
	if [ "$RUN_STATUS" -ne "$expected" ]; then
		fail "$name" "verdict=$want but expected exit $expected, got $RUN_STATUS"
		return
	fi
	pass "$name"
}

# assert_never_done <name> <args...>
#
# The single most important assertion in this suite: whatever else happens,
# this input must not be readable as "done". Neither exit 0 nor the string
# `verdict=done` may appear.
assert_never_done() {
	local name="$1"
	shift
	run_parser "$@"
	if [ "$RUN_STATUS" -eq 0 ]; then
		fail "$name" "resolved to DONE (exit 0): [$RUN_OUT]"
		return
	fi
	case "$RUN_OUT" in
	*verdict=done*)
		fail "$name" "stdout claims verdict=done: [$RUN_OUT]"
		return
		;;
	esac
	pass "$name"
}

# assert_reports <name> <needle> <args...>
assert_reports() {
	local name="$1" needle="$2"
	shift 2
	run_parser "$@"
	case "$RUN_ERR" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "diagnostic did not mention '$needle': [$RUN_ERR]" ;;
	esac
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

if [ ! -f "$PARSER" ]; then
	printf 'FAIL  parser-present\n        no parser at %s\n' "$PARSER"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "parser-present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/parse-acs-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"

# --------------------------------------------------------------------------
# 1. Happy path — mixed checked/unchecked counted correctly
# --------------------------------------------------------------------------

cat >"$ROOT/mixed.md" <<'EOF'
# Acceptance criteria

Goal: the gate never permits a stop on unfinished work.

## Done when

- [x] **CRITICAL** A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh empty.md` → exit 2
      - at: 2026-07-19T14:02:11Z

- [x] The resolver returns a sibling folder — `.claude/skills/goal-gate/goal-folder-path.sh`
      - evidence: `bash test-goal-folder-contract.sh` → 26 passed, 0 failed

- [ ] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - explanation: not yet implemented.

- [ ] The run log records each decision — `.claude/skills/goal-gate/run-all.sh`
      - explanation: blocked on the wiring task.

- [ ] Live registration is verified — `.claude/skills/goal-gate/register.sh`
      - explanation: the live invocation has not been run yet.

## Notes

Prose here is not a criterion.
EOF

assert_exit "happy/mixed-file-parses" 1 "$ROOT/mixed.md"
assert_count "happy/total" total 5 "$ROOT/mixed.md"
assert_count "happy/checked" checked 2 "$ROOT/mixed.md"
assert_count "happy/unchecked" unchecked 3 "$ROOT/mixed.md"
assert_count "happy/unknown-is-zero" unknown 0 "$ROOT/mixed.md"
assert_count "happy/explanations-counted" explanations 3 "$ROOT/mixed.md"
assert_count "happy/evidence-counted" evidence 2 "$ROOT/mixed.md"
assert_count "happy/nested-is-zero" nested 0 "$ROOT/mixed.md"
assert_count "happy/unrecognised-is-zero" unrecognised 0 "$ROOT/mixed.md"
assert_count "happy/nonconforming-is-zero" nonconforming 0 "$ROOT/mixed.md"
assert_verdict "happy/outstanding-work-is-not-done" "not_done" 1 "$ROOT/mixed.md"

# total = checked + unchecked + unknown, always.
run_parser "$ROOT/mixed.md"
h_total="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^total=//p')"
h_checked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^checked=//p')"
h_unchecked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^unchecked=//p')"
h_unknown="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^unknown=//p')"
assert_equals "happy/total-equals-checked-plus-unchecked-plus-unknown" \
	"$h_total" "$((h_checked + h_unchecked + h_unknown))"

# All ticked: the only shape that is genuinely done.
cat >"$ROOT/all-done.md" <<'EOF'
- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh empty.md` → exit 2
- [x] The gate blocks on an unticked box — `.claude/skills/goal-gate/run-all.sh`
      - evidence: `bash run-all.sh one-unticked.md` → exit 1
EOF
assert_verdict "happy/all-ticked-is-done" "done" 0 "$ROOT/all-done.md"
assert_count "happy/all-ticked-total" total 2 "$ROOT/all-done.md"
assert_count "happy/all-ticked-unchecked" unchecked 0 "$ROOT/all-done.md"

# One unticked among many ticked must flip the verdict.
cat >"$ROOT/one-outstanding.md" <<'EOF'
- [x] A — `a/one.sh`
      - evidence: ran it
- [x] B — `a/two.sh`
      - evidence: ran it
- [ ] C — `a/three.sh`
      - explanation: not started
EOF
assert_verdict "happy/one-unticked-flips-the-verdict" "not_done" 1 "$ROOT/one-outstanding.md"
assert_count "happy/one-unticked-counted" unchecked 1 "$ROOT/one-outstanding.md"

# --------------------------------------------------------------------------
# 2. Invalid input — checkbox states are parsed exactly, or rejected. Never
#    guessed.
# --------------------------------------------------------------------------

printf -- '- [x] Exact tick — `a/b.sh`\n' >"$ROOT/box-x.md"
assert_verdict "box/lowercase-x-is-checked" "done" 0 "$ROOT/box-x.md"
assert_count "box/lowercase-x-checked-count" checked 1 "$ROOT/box-x.md"

printf -- '- [ ] Exact blank — `a/b.sh`\n' >"$ROOT/box-space.md"
assert_verdict "box/single-space-is-unchecked" "not_done" 1 "$ROOT/box-space.md"
assert_count "box/single-space-unchecked-count" unchecked 1 "$ROOT/box-space.md"

# `[X]`, `[-]`, `[]`, `[  ]` are NOT the contract. Each is rejected as an
# unknown state — never coerced to checked (which would fabricate completion)
# and never coerced to unchecked (which would silently rewrite the author's
# intent). The state is simply not readable, so the file is not done.
for variant in 'X' '-' '' '  '; do
	label="$(printf '%s' "$variant" | tr ' ' '_')"
	[ -n "$label" ] || label="empty"
	printf -- '- [%s] A criterion — `a/b.sh`\n' "$variant" >"$ROOT/box-$label.md"
	assert_refused "box/$label-rejected" 4 "$ROOT/box-$label.md"
	assert_never_done "box/$label-never-done" "$ROOT/box-$label.md"
	assert_reports "box/$label-named-as-unknown-state" "unknown checkbox state" \
		"$ROOT/box-$label.md"
done

# The specific trap: an uppercase tick must not be read as "checked" and thus
# permit completion.
assert_never_done "box/uppercase-X-does-not-permit-completion" "$ROOT/box-X.md"

# --------------------------------------------------------------------------
# 3. List-prefix variants — the vacuous-truth trap through the front door
# --------------------------------------------------------------------------
#
# A parser written only for `- [ ]` silently DROPS a criterion written `* [ ]`.
# Dropping an UNCHECKED criterion reduces unmet to zero and PERMITS completion.
# Fail-closed does not catch it, because nothing errors. Every list prefix must
# therefore be RECOGNISED — counted, reported, and refused as non-canonical —
# never skipped.

cat >"$ROOT/star-hidden.md" <<'EOF'
- [x] The done one — `a/done.sh`
      - evidence: ran it
* [ ] The outstanding one written with a star — `a/outstanding.sh`
      - explanation: not started
EOF
assert_never_done "prefix/star-criterion-cannot-permit-completion" "$ROOT/star-hidden.md"
assert_refused "prefix/star-criterion-refused" 4 "$ROOT/star-hidden.md"
assert_reports "prefix/star-criterion-is-seen-not-dropped" "non-canonical list prefix" \
	"$ROOT/star-hidden.md"

for spec in '*:star' '+:plus' '1.:ordered-dot' '1):ordered-paren'; do
	prefix="${spec%%:*}"
	name="${spec##*:}"
	printf -- '%s [ ] An outstanding criterion — `a/b.sh`\n' "$prefix" >"$ROOT/prefix-$name.md"
	assert_never_done "prefix/$name-never-done" "$ROOT/prefix-$name.md"
	assert_reports "prefix/$name-is-recognised" "line 1:" "$ROOT/prefix-$name.md"
done

# Even an ALL-TICKED non-canonical file is refused: the tick is not readable as
# canonical, so it may not close the contract.
printf -- '* [x] A ticked criterion — `a/b.sh`\n' >"$ROOT/prefix-star-ticked.md"
assert_never_done "prefix/star-ticked-still-refused" "$ROOT/prefix-star-ticked.md"
assert_refused "prefix/star-ticked-exit-4" 4 "$ROOT/prefix-star-ticked.md"

# The canonical prefix is the ONLY one that parses clean.
printf -- '- [x] A ticked criterion — `a/b.sh`\n' >"$ROOT/prefix-dash.md"
assert_verdict "prefix/canonical-dash-accepted" "done" 0 "$ROOT/prefix-dash.md"

# Extra whitespace between the prefix and the box is non-canonical, not a licence
# to guess.
printf -- '-   [x] A ticked criterion — `a/b.sh`\n' >"$ROOT/prefix-wide-gap.md"
assert_never_done "prefix/wide-gap-refused" "$ROOT/prefix-wide-gap.md"

# No space after the checkbox.
printf -- '- [x]Squashed criterion — `a/b.sh`\n' >"$ROOT/no-space-after-box.md"
assert_never_done "prefix/no-space-after-box-refused" "$ROOT/no-space-after-box.md"
assert_reports "prefix/no-space-after-box-reported" "no space after the checkbox" \
	"$ROOT/no-space-after-box.md"

# --------------------------------------------------------------------------
# 4. Unrecognised checkbox-like lines — the guard that closes the class
# --------------------------------------------------------------------------
#
# Any line containing checkbox-like text that the parser does not classify as a
# criterion is REPORTED and refuses completion. It is never silently skipped.

cat >"$ROOT/unrecognised-prose.md" <<'EOF'
- [x] The done one — `a/done.sh`
      - evidence: ran it

Remaining: [ ] wire up the run log
EOF
assert_never_done "unrecognised/prose-checkbox-refuses-completion" \
	"$ROOT/unrecognised-prose.md"
assert_refused "unrecognised/prose-checkbox-exit-4" 4 "$ROOT/unrecognised-prose.md"
assert_reports "unrecognised/prose-checkbox-reported" "unrecognised checkbox-like line" \
	"$ROOT/unrecognised-prose.md"

# A missing space after the dash makes it not a list item at all.
cat >"$ROOT/unrecognised-tight-dash.md" <<'EOF'
- [x] The done one — `a/done.sh`
      - evidence: ran it
-[ ] The outstanding one — `a/outstanding.sh`
EOF
assert_never_done "unrecognised/tight-dash-refuses-completion" \
	"$ROOT/unrecognised-tight-dash.md"

# A bare checkbox with no list prefix at all.
cat >"$ROOT/unrecognised-bare.md" <<'EOF'
- [x] The done one — `a/done.sh`
      - evidence: ran it
[ ] The outstanding one — `a/outstanding.sh`
EOF
assert_never_done "unrecognised/bare-checkbox-refuses-completion" \
	"$ROOT/unrecognised-bare.md"

# An indented continuation line that smuggles a checkbox is equally suspect.
cat >"$ROOT/unrecognised-indented.md" <<'EOF'
- [x] The done one — `a/done.sh`
      - evidence: ran it
      also [ ] finish the run log
EOF
assert_never_done "unrecognised/indented-smuggled-checkbox-refuses" \
	"$ROOT/unrecognised-indented.md"

# --------------------------------------------------------------------------
# 5. Empty / null — THE VACUOUS-TRUTH TRAP
# --------------------------------------------------------------------------
#
# Zero criteria is an ERROR, not "0 unchecked, therefore done". This is the
# marquee class: every one of these must be an error AND must not print any
# count a caller could misread.

: >"$ROOT/empty.md"
assert_refused "empty/empty-file-is-an-error" 2 "$ROOT/empty.md"
assert_never_done "empty/empty-file-never-done" "$ROOT/empty.md"

printf '   \n\n\t\n' >"$ROOT/whitespace.md"
assert_refused "empty/whitespace-only-is-an-error" 2 "$ROOT/whitespace.md"
assert_never_done "empty/whitespace-only-never-done" "$ROOT/whitespace.md"

cat >"$ROOT/prose-only.md" <<'EOF'
# Acceptance criteria

Goal: everything works.

We are confident this is finished.
EOF
assert_refused "empty/prose-only-is-an-error" 2 "$ROOT/prose-only.md"
assert_never_done "empty/prose-only-never-done" "$ROOT/prose-only.md"
assert_reports "empty/zero-criteria-named-as-such" "zero criteria is not 'all complete'" \
	"$ROOT/prose-only.md"

# The trap stated exactly: a zero-criteria file must not report unchecked=0.
run_parser "$ROOT/prose-only.md"
case "$RUN_OUT" in
*unchecked=0*) fail "empty/zero-criteria-does-not-report-unchecked-zero" \
	"a zero-criteria file printed unchecked=0: [$RUN_OUT]" ;;
*) pass "empty/zero-criteria-does-not-report-unchecked-zero" ;;
esac

assert_refused "empty/missing-file" 3 "$ROOT/does-not-exist.md"
assert_refused "empty/empty-path-argument" 3 ""
assert_refused "empty/no-argument" 64
assert_never_done "empty/missing-file-never-done" "$ROOT/does-not-exist.md"

# --------------------------------------------------------------------------
# 6. Error propagation — a failure reports itself and emits NO counts
# --------------------------------------------------------------------------

mkdir -p "$ROOT/adir"
assert_refused "error/path-is-a-directory" 3 "$ROOT/adir"

printf -- '- [x] A — `a/b.sh`\n' >"$ROOT/unreadable.md"
chmod 000 "$ROOT/unreadable.md"
if [ "$(id -u)" -ne 0 ] && [ ! -r "$ROOT/unreadable.md" ]; then
	assert_refused "error/unreadable-file-reports-and-emits-no-counts" 3 "$ROOT/unreadable.md"
	assert_never_done "error/unreadable-file-never-done" "$ROOT/unreadable.md"
else
	pass "error/unreadable-file-skipped-running-as-root"
	pass "error/unreadable-file-skipped-running-as-root-2"
fi
chmod 644 "$ROOT/unreadable.md"

# A symlink is refused: this file decides whether work is done, and a symlink
# can redirect the verdict at an all-ticked file outside the goal folder.
printf -- '- [x] Everything is finished — `a/b.sh`\n' >"$ROOT/elsewhere.md"
ln -s "$ROOT/elsewhere.md" "$ROOT/link-to-file.md"
assert_refused "error/symlink-to-file-refused" 3 "$ROOT/link-to-file.md"
assert_never_done "error/symlink-cannot-redirect-the-verdict" "$ROOT/link-to-file.md"
assert_reports "error/symlink-named-as-such" "symlink" "$ROOT/link-to-file.md"

ln -s "$ROOT/adir" "$ROOT/link-to-dir.md"
assert_refused "error/symlink-to-directory-refused" 3 "$ROOT/link-to-dir.md"

ln -s "$ROOT/nothing-here.md" "$ROOT/link-dangling.md"
assert_refused "error/dangling-symlink-refused" 3 "$ROOT/link-dangling.md"

# A non-regular file is not an ACs.md.
if command -v mkfifo >/dev/null 2>&1 && mkfifo "$ROOT/fifo.md" 2>/dev/null; then
	assert_refused "error/fifo-is-not-a-regular-file" 3 "$ROOT/fifo.md"
	rm -f -- "$ROOT/fifo.md"
else
	pass "error/fifo-skipped-unavailable"
fi

assert_refused "error/unknown-option" 64 --bogus "$ROOT/mixed.md"
assert_refused "error/too-many-arguments" 64 "$ROOT/mixed.md" "$ROOT/mixed.md"

# --------------------------------------------------------------------------
# 7. Security boundaries — checkbox-like text that is NOT a criterion
# --------------------------------------------------------------------------
#
# Excluded contexts must not contribute to the counts. Equally, an exclusion
# must not swallow a real criterion that follows it.

cat >"$ROOT/fenced.md" <<'EOF'
- [ ] The real outstanding criterion — `a/real.sh`
      - explanation: not started

Example of the format:

```markdown
- [x] This is documentation, not a criterion — `a/doc.sh`
- [x] Nor is this — `a/doc2.sh`
```

- [x] The real done criterion — `a/done.sh`
      - evidence: ran it
EOF
assert_count "security/fenced-block-excluded-total" total 2 "$ROOT/fenced.md"
assert_count "security/fenced-block-excluded-checked" checked 1 "$ROOT/fenced.md"
assert_count "security/fence-does-not-swallow-later-criteria" unchecked 1 "$ROOT/fenced.md"
assert_verdict "security/fenced-example-cannot-fake-completion" "not_done" 1 "$ROOT/fenced.md"

cat >"$ROOT/tilde-fence.md" <<'EOF'
- [ ] The real outstanding criterion — `a/real.sh`
      - explanation: not started

~~~
- [x] Not a criterion — `a/doc.sh`
~~~
EOF
assert_count "security/tilde-fence-excluded" total 1 "$ROOT/tilde-fence.md"
assert_verdict "security/tilde-fence-not-done" "not_done" 1 "$ROOT/tilde-fence.md"

cat >"$ROOT/blockquote.md" <<'EOF'
- [ ] The real outstanding criterion — `a/real.sh`
      - explanation: not started

The reviewer wrote:

> - [x] I think this one is finished — `a/quoted.sh`
> - [x] And this one — `a/quoted2.sh`
EOF
assert_count "security/blockquote-excluded" total 1 "$ROOT/blockquote.md"
assert_verdict "security/quoted-ticks-cannot-complete" "not_done" 1 "$ROOT/blockquote.md"

# 4-space indented code block — the fenced/quoted rule alone misses this one.
cat >"$ROOT/indented-code.md" <<'EOF'
- [ ] The real outstanding criterion — `a/real.sh`
      - explanation: not started

Here is the shape of a checklist:

    - [x] Not a criterion — `a/doc.sh`
    - [x] Nor this — `a/doc2.sh`

Back to prose.
EOF
assert_count "security/4-space-code-block-excluded" total 1 "$ROOT/indented-code.md"
assert_verdict "security/4-space-code-block-cannot-complete" "not_done" 1 \
	"$ROOT/indented-code.md"

printf -- 'Here is the shape:\n\n\t- [x] Not a criterion — `a/doc.sh`\n\nBack to prose.\n' \
	>"$ROOT/tab-code.md"
assert_never_done "security/tab-indented-code-block-cannot-complete" "$ROOT/tab-code.md"

# HTML comments.
cat >"$ROOT/html-comment.md" <<'EOF'
- [ ] The real outstanding criterion — `a/real.sh`
      - explanation: not started

<!-- - [x] A commented-out criterion — `a/hidden.sh` -->

<!--
- [x] A multi-line commented criterion — `a/hidden2.sh`
- [x] And another — `a/hidden3.sh`
-->

- [x] The real done criterion — `a/done.sh`
      - evidence: ran it
EOF
assert_count "security/html-comment-excluded-total" total 2 "$ROOT/html-comment.md"
assert_count "security/html-comment-does-not-swallow-later-criteria" checked 1 \
	"$ROOT/html-comment.md"
assert_verdict "security/commented-ticks-cannot-complete" "not_done" 1 "$ROOT/html-comment.md"

# Inline backticked examples in prose.
cat >"$ROOT/inline-backtick.md" <<'EOF'
- [x] The real done criterion — `a/done.sh`
      - evidence: ran it

Write an unmet criterion as `- [ ] text` and a met one as `- [x] text`.
EOF
assert_count "security/inline-backticked-example-excluded" total 1 "$ROOT/inline-backtick.md"
assert_count "security/inline-backticked-example-not-unrecognised" unrecognised 0 \
	"$ROOT/inline-backtick.md"
assert_verdict "security/inline-backticked-example-does-not-block" "done" 0 \
	"$ROOT/inline-backtick.md"

# A file whose ONLY checkbox text is inside excluded contexts has ZERO criteria
# — and zero criteria is an error, never "nothing outstanding, therefore done".
cat >"$ROOT/all-excluded.md" <<'EOF'
# Acceptance criteria

```
- [x] fenced — `a/a.sh`
```

> - [x] quoted — `a/b.sh`

    - [x] indented — `a/c.sh`

<!-- - [x] commented — `a/d.sh` -->

Inline `- [x] backticked` example.
EOF
assert_refused "security/only-excluded-checkboxes-is-zero-criteria" 2 "$ROOT/all-excluded.md"
assert_never_done "security/only-excluded-checkboxes-never-done" "$ROOT/all-excluded.md"

# --------------------------------------------------------------------------
# 8. Boundary
# --------------------------------------------------------------------------

# Nested / indented criteria under a parent. Per the format contract §3.1 an
# indented task item is an illustration, not a criterion: it is COUNTED as
# `nested` so it is never invisible, but it does not move the verdict.
cat >"$ROOT/nested.md" <<'EOF'
- [x] The parent criterion — `a/parent.sh`
      - evidence: ran it
  - [ ] A nested illustration — `a/child.sh`
  - [x] Another nested illustration — `a/child2.sh`
EOF
assert_count "boundary/nested-items-not-counted-as-criteria" total 1 "$ROOT/nested.md"
assert_count "boundary/nested-items-counted-separately" nested 2 "$ROOT/nested.md"
assert_count "boundary/nested-items-not-in-unchecked" unchecked 0 "$ROOT/nested.md"
assert_verdict "boundary/nested-illustration-does-not-block" "done" 0 "$ROOT/nested.md"

# A tab-indented task item under a parent is nested, not a top-level criterion:
# a tab must not read as column 0.
printf -- '- [x] The parent criterion — `a/parent.sh`\n      - evidence: ran it\n\t- [ ] A tab-nested illustration — `a/child.sh`\n' \
	>"$ROOT/tab-nested.md"
assert_count "boundary/tab-indent-is-not-column-zero" total 1 "$ROOT/tab-nested.md"
assert_count "boundary/tab-indented-item-counted-as-nested" nested 1 "$ROOT/tab-nested.md"

# CRLF line endings must parse identically to LF.
printf -- '- [x] A — `a/a.sh`\r\n      - evidence: ran it\r\n- [ ] B — `a/b.sh`\r\n      - explanation: pending\r\n' \
	>"$ROOT/crlf.md"
assert_count "boundary/crlf-total" total 2 "$ROOT/crlf.md"
assert_count "boundary/crlf-checked" checked 1 "$ROOT/crlf.md"
assert_count "boundary/crlf-unchecked" unchecked 1 "$ROOT/crlf.md"
assert_count "boundary/crlf-explanations" explanations 1 "$ROOT/crlf.md"
assert_count "boundary/crlf-no-unrecognised-lines" unrecognised 0 "$ROOT/crlf.md"
assert_verdict "boundary/crlf-verdict" "not_done" 1 "$ROOT/crlf.md"

# CRLF must not defeat the tick either.
printf -- '- [x] A — `a/a.sh`\r\n' >"$ROOT/crlf-done.md"
assert_verdict "boundary/crlf-all-ticked-is-done" "done" 0 "$ROOT/crlf-done.md"

# No trailing newline — the last criterion must still be counted.
printf -- '- [x] A — `a/a.sh`\n- [ ] B — `a/b.sh`' >"$ROOT/no-trailing-newline.md"
assert_count "boundary/no-trailing-newline-total" total 2 "$ROOT/no-trailing-newline.md"
assert_count "boundary/no-trailing-newline-last-item-counted" unchecked 1 \
	"$ROOT/no-trailing-newline.md"
assert_verdict "boundary/no-trailing-newline-verdict" "not_done" 1 \
	"$ROOT/no-trailing-newline.md"

# A single pathological line, no newline at all.
printf -- '- [ ] The only criterion, unterminated — `a/a.sh`' >"$ROOT/single-line.md"
assert_count "boundary/single-unterminated-line-total" total 1 "$ROOT/single-line.md"
assert_verdict "boundary/single-unterminated-line-not-done" "not_done" 1 "$ROOT/single-line.md"

# A criterion spanning wrapped lines: the continuation is not a second
# criterion, and it is not unrecognised.
cat >"$ROOT/wrapped.md" <<'EOF'
- [ ] The gate refuses to permit a stop while any criterion remains
      unmet, and records the refusal in the run log — `a/run-all.sh`
      - explanation: the wiring task has not landed.
- [x] A short one — `a/b.sh`
      - evidence: ran it
EOF
assert_count "boundary/wrapped-criterion-counted-once" total 2 "$ROOT/wrapped.md"
assert_count "boundary/wrapped-continuation-not-unrecognised" unrecognised 0 \
	"$ROOT/wrapped.md"
assert_count "boundary/wrapped-criterion-explanation-counted" explanations 1 \
	"$ROOT/wrapped.md"

# Exactly one criterion, each way.
printf -- '- [x] The only criterion — `a/a.sh`\n' >"$ROOT/one-checked.md"
assert_count "boundary/exactly-one-checked-total" total 1 "$ROOT/one-checked.md"
assert_verdict "boundary/exactly-one-checked-done" "done" 0 "$ROOT/one-checked.md"
printf -- '- [ ] The only criterion — `a/a.sh`\n' >"$ROOT/one-unchecked.md"
assert_verdict "boundary/exactly-one-unchecked-not-done" "not_done" 1 "$ROOT/one-unchecked.md"

# Duplicate criterion text. POLICY: NO DEDUPLICATION. Identical text is counted
# twice and `duplicates` is advisory only. De-duplicating could drop an
# unchecked duplicate of a checked criterion, reducing unmet to zero.
cat >"$ROOT/duplicates.md" <<'EOF'
- [x] The gate blocks on an unticked box — `a/run-all.sh`
      - evidence: ran it
- [ ] The gate blocks on an unticked box — `a/run-all.sh`
      - explanation: the second instance is genuinely outstanding.
EOF
assert_count "boundary/duplicate-text-counted-twice" total 2 "$ROOT/duplicates.md"
assert_count "boundary/duplicate-text-reported" duplicates 1 "$ROOT/duplicates.md"
assert_count "boundary/duplicate-unchecked-survives-dedup-policy" unchecked 1 \
	"$ROOT/duplicates.md"
assert_verdict "boundary/duplicate-unchecked-blocks-completion" "not_done" 1 \
	"$ROOT/duplicates.md"

# Non-ASCII UTF-8 (em dashes, accents) parses cleanly.
printf -- '- [x] Le critère est rempli — `a/été.sh`\n      - evidence: exécuté\n' \
	>"$ROOT/utf8.md"
assert_verdict "boundary/valid-utf8-parses" "done" 0 "$ROOT/utf8.md"

# --------------------------------------------------------------------------
# 9. Git merge-conflict markers
# --------------------------------------------------------------------------
#
# A checked side from `main` could mask an unchecked local one, so a conflicted
# file has no readable verdict at all: refuse and report.

cat >"$ROOT/conflict.md" <<'EOF'
<<<<<<< HEAD
- [x] The gate blocks on an unticked box — `a/run-all.sh`
      - evidence: ran it
=======
- [ ] The gate blocks on an unticked box — `a/run-all.sh`
      - explanation: not implemented on this branch.
>>>>>>> main
EOF
assert_refused "conflict/markers-refused" 6 "$ROOT/conflict.md"
assert_never_done "conflict/checked-side-cannot-mask-unchecked" "$ROOT/conflict.md"
assert_reports "conflict/markers-reported" "merge-conflict marker" "$ROOT/conflict.md"

# A bare `=======` is a valid markdown setext heading rule — not a conflict.
cat >"$ROOT/setext.md" <<'EOF'
Acceptance criteria
===================

- [x] The only criterion — `a/a.sh`
      - evidence: ran it
EOF
assert_verdict "conflict/setext-heading-is-not-a-conflict" "done" 0 "$ROOT/setext.md"

# --------------------------------------------------------------------------
# 10. Encoding — reported as an ENCODING error, never as "no criteria"
# --------------------------------------------------------------------------

printf '\xef\xbb\xbf- [x] A — `a/a.sh`\n' >"$ROOT/bom.md"
assert_refused "encoding/bom-is-an-encoding-error" 5 "$ROOT/bom.md"
assert_reports "encoding/bom-named-as-such" "BOM" "$ROOT/bom.md"
assert_never_done "encoding/bom-never-done" "$ROOT/bom.md"

printf '\xef\xbb\xbf\n' >"$ROOT/bom-only.md"
assert_refused "encoding/bom-only-file-is-encoding-not-no-criteria" 5 "$ROOT/bom-only.md"

printf -- '- [x] A \xff\xfe broken byte — `a/a.sh`\n' >"$ROOT/bad-utf8.md"
if command -v iconv >/dev/null 2>&1; then
	assert_refused "encoding/invalid-utf8-is-an-encoding-error" 5 "$ROOT/bad-utf8.md"
	assert_never_done "encoding/invalid-utf8-never-done" "$ROOT/bad-utf8.md"
else
	pass "encoding/invalid-utf8-skipped-no-iconv"
	pass "encoding/invalid-utf8-skipped-no-iconv-2"
fi

printf -- '- [x] A — `a/a.sh`\n\000\000\n' >"$ROOT/nul.md"
assert_refused "encoding/nul-bytes-are-an-encoding-error" 5 "$ROOT/nul.md"
assert_never_done "encoding/nul-bytes-never-done" "$ROOT/nul.md"

# --------------------------------------------------------------------------
# 11. Concurrency — a complete parse or an error, NEVER a partial verdict
# --------------------------------------------------------------------------
#
# A file appended to during the read must never yield a half-read count set.
# Both outcomes are legitimate; what is asserted is that a partial verdict is
# not one of them.

{
	printf '# Acceptance criteria\n\n'
	i=1
	while [ "$i" -le 400 ]; do
		printf -- '- [x] Criterion %d — `a/c%d.sh`\n      - evidence: ran it\n' "$i" "$i"
		i=$((i + 1))
	done
} >"$ROOT/growing.md"

concurrency_ok=1
concurrency_note=""
round=1
while [ "$round" -le 5 ]; do
	(
		j=1
		while [ "$j" -le 200 ]; do
			printf -- '- [ ] Appended criterion %d — `a/x%d.sh`\n      - explanation: appended mid-read\n' \
				"$j" "$j" >>"$ROOT/growing.md"
			j=$((j + 1))
		done
	) &
	appender=$!
	run_parser "$ROOT/growing.md"
	wait "$appender" 2>/dev/null || true

	if [ "$RUN_STATUS" -le 1 ]; then
		# A parse: the count set must be complete and internally consistent.
		c_total="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^total=//p')"
		c_checked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^checked=//p')"
		c_unchecked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^unchecked=//p')"
		c_unknown="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^unknown=//p')"
		c_blocked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^blocked=//p')"
		c_lines="$(printf '%s\n' "$RUN_OUT" | grep -c '=')"
		# 13 keys: the original 11 plus `blocked=` and `reasons=`. The count is
		# asserted exactly, not as a minimum — a SHORT result set is the partial
		# verdict this test exists to catch.
		if [ "$c_lines" -ne 13 ]; then
			concurrency_ok=0
			concurrency_note="round $round: partial result set ($c_lines keys): [$RUN_OUT]"
			break
		fi
		if [ "$c_total" -ne "$((c_checked + c_unchecked + c_blocked + c_unknown))" ]; then
			concurrency_ok=0
			concurrency_note="round $round: inconsistent counts: [$RUN_OUT]"
			break
		fi
	else
		# An error: no counts may have leaked.
		if [ -n "$RUN_OUT" ]; then
			concurrency_ok=0
			concurrency_note="round $round: error exit $RUN_STATUS leaked stdout: [$RUN_OUT]"
			break
		fi
	fi
	round=$((round + 1))
done
if [ "$concurrency_ok" -eq 1 ]; then
	pass "concurrency/append-during-read-never-yields-a-partial-verdict"
else
	fail "concurrency/append-during-read-never-yields-a-partial-verdict" "$concurrency_note"
fi

# The growing file ends with 200 unticked criteria appended: whatever snapshot
# was read, it cannot be "done" once the appends have landed.
assert_verdict "concurrency/appended-unticked-criteria-block-completion" "not_done" 1 \
	"$ROOT/growing.md"

# --------------------------------------------------------------------------
# 12. Timing — comfortably inside the tightest host hook timeout (120s)
# --------------------------------------------------------------------------

# Generated with awk, not a bash loop: the point of this test is to measure the
# PARSER, so fixture construction must not dominate the wall clock.
awk 'BEGIN {
	print "# A large acceptance-criteria file";
	print "";
	for (i = 1; i <= 20000; i++) {
		if (i % 40 == 0) {
			printf "- [x] Criterion %d is met — `a/c%d.sh`\n      - evidence: ran it\n", i, i;
		} else {
			printf "Narrative line %d describing the workstream in some detail.\n", i;
		}
	}
}' >"$ROOT/large.md"

TIMING_BUDGET=60
start_ts=$SECONDS
run_parser "$ROOT/large.md"
elapsed=$((SECONDS - start_ts))
large_status=$RUN_STATUS
large_total="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^total=//p')"

if [ "$large_status" -ne 0 ]; then
	fail "timing/large-file-parses" "exit $large_status (err=[$RUN_ERR])"
else
	pass "timing/large-file-parses"
fi
assert_equals "timing/large-file-counts-every-criterion" "500" "$large_total"
if [ "$elapsed" -lt "$TIMING_BUDGET" ]; then
	pass "timing/large-file-within-hook-budget (${elapsed}s < ${TIMING_BUDGET}s of the 120s host timeout)"
else
	fail "timing/large-file-within-hook-budget" \
		"took ${elapsed}s, budget ${TIMING_BUDGET}s (host hook timeout is 120s)"
fi

# --------------------------------------------------------------------------
# 13. Layering — this script CONSUMES acs-format-check.sh, it does not
#     re-implement it
# --------------------------------------------------------------------------

FORMAT_CHECKER="${TEST_DIR}/../acs-format-check.sh"
if [ -f "$FORMAT_CHECKER" ]; then
	pass "layering/format-checker-present"

	# A surrogate reference is a FORMAT error (T1.2's rule). Without
	# --format-check this parser must NOT enforce it: counting and the verdict
	# are its layer, lexical conformance is not. Proving the absence of the rule
	# here is what proves the layers are not duplicated.
	cat >"$ROOT/surrogate.md" <<'EOF'
- [x] The parser rejects an empty file — `tests/mock-parser.sh`
      - evidence: `bash tests/mock-parser.sh empty.md` → exit 2
EOF
	assert_verdict "layering/surrogate-not-re-implemented-here" "done" 0 "$ROOT/surrogate.md"

	# With --format-check the refusal is DELEGATED and its exit code propagated
	# unchanged (4 = format error).
	assert_refused "layering/format-check-delegates-surrogate-refusal" 4 \
		--format-check "$ROOT/surrogate.md"

	# Delegation must also propagate the evidence rule (exit 5) — enforced by
	# T1.2, never duplicated here.
	printf -- '- [x] A criterion — `a/b.sh`\n' >"$ROOT/tick-no-evidence.md"
	assert_verdict "layering/evidence-not-enforced-without-format-check" "done" 0 \
		"$ROOT/tick-no-evidence.md"
	assert_refused "layering/format-check-delegates-evidence-refusal" 5 \
		--format-check "$ROOT/tick-no-evidence.md"

	# And the explanation rule (exit 6), with --authoring relaxing it.
	printf -- '- [ ] A criterion — `a/b.sh`\n' >"$ROOT/untick-no-explanation.md"
	assert_refused "layering/format-check-delegates-explanation-refusal" 6 \
		--format-check "$ROOT/untick-no-explanation.md"
	assert_verdict "layering/format-check-authoring-relaxes-explanation" "not_done" 1 \
		--format-check --authoring "$ROOT/untick-no-explanation.md"

	# A conformant file passes both layers and keeps the same verdict.
	assert_verdict "layering/format-check-keeps-the-verdict-on-a-valid-file" "not_done" 1 \
		--format-check "$ROOT/mixed.md"
	assert_count "layering/format-check-keeps-the-counts" total 5 \
		--format-check "$ROOT/mixed.md"

	# Delegation must never turn a zero-criteria file into a pass.
	assert_never_done "layering/format-check-does-not-rescue-zero-criteria" \
		--format-check "$ROOT/prose-only.md"
else
	fail "layering/format-checker-present" "no checker at $FORMAT_CHECKER"
fi

# The shipped template has zero criteria BY CONSTRUCTION and must therefore
# never parse as done.
TEMPLATE="${TEST_DIR}/../../eque2-code-prepare-goal/assets/ACs-template.md"
if [ -f "$TEMPLATE" ]; then
	pass "layering/template-present"
	assert_never_done "layering/template-is-never-done-by-construction" "$TEMPLATE"
else
	fail "layering/template-present" "no template at $TEMPLATE"
fi

# --------------------------------------------------------------------------
# 14. stdout discipline — a sweep across every refusal fixture
# --------------------------------------------------------------------------
#
# Restated as a single sweep because it is the property the whole design rests
# on: `verdict=done` is observable ONLY on exit 0, and an error path prints
# nothing a caller could parse.

discipline_ok=1
discipline_note=""
for fixture in empty.md whitespace.md prose-only.md all-excluded.md conflict.md \
	bom.md bom-only.md nul.md adir does-not-exist.md link-to-file.md \
	box-X.md box-empty.md star-hidden.md unrecognised-prose.md \
	prefix-star-ticked.md; do
	run_parser "$ROOT/$fixture"
	if [ "$RUN_STATUS" -eq 0 ]; then
		discipline_ok=0
		discipline_note="$fixture exited 0"
		break
	fi
	if [ -n "$RUN_OUT" ]; then
		discipline_ok=0
		discipline_note="$fixture leaked stdout on exit $RUN_STATUS: [$RUN_OUT]"
		break
	fi
	case "$RUN_ERR" in
	*parse-acs:*) : ;;
	*)
		discipline_ok=0
		discipline_note="$fixture failed silently (no diagnostic) on exit $RUN_STATUS"
		break
		;;
	esac
done
if [ "$discipline_ok" -eq 1 ]; then
	pass "discipline/every-refusal-is-loud-and-emits-no-counts"
else
	fail "discipline/every-refusal-is-loud-and-emits-no-counts" "$discipline_note"
fi

# --help must not be mistaken for a verdict.
run_parser --help
if [ "$RUN_STATUS" -eq 0 ]; then
	case "$RUN_OUT" in
	*verdict=done*) fail "discipline/help-does-not-emit-a-verdict" "--help printed verdict=done" ;;
	*) pass "discipline/help-does-not-emit-a-verdict" ;;
	esac
else
	fail "discipline/help-does-not-emit-a-verdict" "--help exited $RUN_STATUS"
fi

# --------------------------------------------------------------------------
# The blocked state and the `partial` verdict
#
# The property under test is an exclusion: a blocked criterion is in NEITHER
# count. Out of `unchecked` so it stops driving the nudge; out of `checked` so
# it never buys a pass. `partial` therefore means "the loop may end, as a
# reported non-completion" and rides on exit 1 with not_done, so a consumer that
# has never heard of the third state still reads it as not-a-pass.
# --------------------------------------------------------------------------

cat >"$ROOT/blocked-mixed.md" <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials this run cannot mint.
- [ ] Still outstanding — `scripts/c.sh`
      - explanation: not started.
EOF
assert_exit "blocked/mixed-parses" 1 "$ROOT/blocked-mixed.md"
assert_count "blocked/counted" blocked 1 "$ROOT/blocked-mixed.md"
assert_count "blocked/excluded-from-unchecked" unchecked 1 "$ROOT/blocked-mixed.md"
assert_count "blocked/never-added-to-checked" checked 1 "$ROOT/blocked-mixed.md"
assert_count "blocked/reason-counted" reasons 1 "$ROOT/blocked-mixed.md"
# Outstanding work OUTRANKS blocked work: while anything is still `[ ]` the
# verdict is the ordinary not_done. Blocking some criteria never releases a turn
# that still has real work left in it.
assert_verdict "blocked/outstanding-outranks-blocked" not_done 1 "$ROOT/blocked-mixed.md"

# Data integrity: the three states account for every criterion.
run_parser "$ROOT/blocked-mixed.md"
bm_total="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^total=//p')"
bm_checked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^checked=//p')"
bm_unchecked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^unchecked=//p')"
bm_blocked="$(printf '%s\n' "$RUN_OUT" | sed -n 's/^blocked=//p')"
assert_equals "blocked/total-accounts-for-all-three-states" \
	"$bm_total" "$((bm_checked + bm_unchecked + bm_blocked))"

# --- Nothing outstanding, something blocked -> partial, exit 1 -------------
cat >"$ROOT/blocked-partial.md" <<'EOF'
- [x] Met one — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
- [!] Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials this run cannot mint.
EOF
assert_verdict "blocked/partial-verdict" partial 1 "$ROOT/blocked-partial.md"
assert_count "blocked/partial-unchecked-is-zero" unchecked 0 "$ROOT/blocked-partial.md"
# The load-bearing property: `partial` is NOT the success family. Exit 1 keeps
# every untaught consumer fail-closed with no edit.
assert_never_done "blocked/partial-is-never-done" "$ROOT/blocked-partial.md"

# --- ALL blocked is not a pass — the vacuous-truth trap in its new form ----
cat >"$ROOT/blocked-all.md" <<'EOF'
- [!] Cannot be done — `scripts/b.sh`
      - blocked: needs production credentials.
- [!] Also cannot — `scripts/c.sh`
      - blocked: same credential wall.
EOF
assert_verdict "blocked/all-blocked-is-partial" partial 1 "$ROOT/blocked-all.md"
assert_count "blocked/all-blocked-has-zero-met" checked 0 "$ROOT/blocked-all.md"
assert_never_done "blocked/all-blocked-is-never-done" "$ROOT/blocked-all.md"

# --- A reasonless `[!]` is COUNTED here, never reclassified ----------------
# Refusing it belongs to acs-format-check.sh (exit 8) and validate-acs.sh. If
# this layer demoted it to `unchecked`, a malformed blocker would hide inside
# ordinary outstanding work and the refusal would never be raised against it.
cat >"$ROOT/blocked-no-reason.md" <<'EOF'
- [!] Cannot be done — `scripts/b.sh`
EOF
assert_count "blocked/reasonless-still-counted-blocked" blocked 1 "$ROOT/blocked-no-reason.md"
assert_count "blocked/reasonless-not-demoted-to-unchecked" unchecked 0 "$ROOT/blocked-no-reason.md"
assert_count "blocked/reasonless-has-no-reason" reasons 0 "$ROOT/blocked-no-reason.md"
# ...and the format layer DOES refuse it, with the distinct code.
assert_refused "blocked/format-check-refuses-reasonless" 8 --format-check "$ROOT/blocked-no-reason.md"

# --- Backwards compatibility: a two-state file reports blocked=0 -----------
assert_count "blocked/two-state-file-reports-zero" blocked 0 "$ROOT/mixed.md"
assert_count "blocked/two-state-file-reports-zero-reasons" reasons 0 "$ROOT/mixed.md"

# --- The silent-drop guard must not regress -------------------------------
# `pacs_has_checkbox_text` gained `[!]`, so a stray one outside a criterion is
# still REPORTED rather than skipped. A parser that skipped it would be dropping
# a line a reader would take for a criterion.
cat >"$ROOT/blocked-stray.md" <<'EOF'
- [x] Met — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0
      A stray [!] in continuation content.
EOF
assert_refused "blocked/stray-bang-is-unrecognised" 4 "$ROOT/blocked-stray.md"

# An INDENTED `- [!]` is an illustration, not a criterion.
cat >"$ROOT/blocked-nested.md" <<'EOF'
- [x] Met — `scripts/a.sh`
      - evidence: `bash scripts/a.sh` → exit 0

  - [!] An illustration in prose — `scripts/b.sh`
        - blocked: illustrative only.
EOF
assert_count "blocked/indented-is-an-illustration" total 1 "$ROOT/blocked-nested.md"
assert_count "blocked/indented-is-not-blocked" blocked 0 "$ROOT/blocked-nested.md"
assert_count "blocked/indented-is-counted-nested" nested 1 "$ROOT/blocked-nested.md"

# --- Zero criteria is still the vacuous-truth trap -------------------------
: >"$ROOT/blocked-empty.md"
assert_refused "blocked/zero-criteria-still-exit-2" 2 "$ROOT/blocked-empty.md"

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
