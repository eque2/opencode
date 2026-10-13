#!/usr/bin/env bash
# test-goal-folder-contract.sh — executable conformance suite for the X.goal/
# folder-layout contract (.claude/skills/prepare-goal/references/goal-folder.md).
#
# Exercises the normative resolver goal-folder-path.sh across all six required
# test-case classes: happy path, invalid input, boundary, empty/null, error
# propagation, security boundaries.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RESOLVER="${TEST_DIR}/../goal-folder-path.sh"

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

# assert_equals <name> <expected> <actual>
assert_equals() {
	if [ "$2" = "$3" ]; then
		pass "$1"
	else
		fail "$1" "expected [$2] got [$3]"
	fi
}

# assert_ok <name> <expected-stdout> <resolver args...>
assert_ok() {
	local name="$1" expected="$2"
	shift 2
	local out status
	out="$(bash "$RESOLVER" "$@" 2>/dev/null)"
	status=$?
	if [ "$status" -ne 0 ]; then
		fail "$name" "expected exit 0, got $status"
		return
	fi
	assert_equals "$name" "$expected" "$out"
}

# assert_fails <name> <expected-exit> <resolver args...>
assert_fails() {
	local name="$1" expected="$2"
	shift 2
	local out status
	out="$(bash "$RESOLVER" "$@" 2>&1)"
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
	*goal-folder:*) pass "$name" ;;
	*) fail "$name" "exit $status correct but no 'goal-folder:' diagnostic: [$out]" ;;
	esac
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

if [ ! -f "$RESOLVER" ]; then
	printf 'FAIL  resolver-present\n        no resolver at %s\n' "$RESOLVER"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "resolver-present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-folder-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"

mkdir -p "$ROOT/ideas/nested"
: >"$ROOT/ideas/X.md"
: >"$ROOT/ideas/a.b.md"
: >"$ROOT/ideas/noext"
: >"$ROOT/ideas/X.goal.md"
: >"$ROOT/ideas/collide.md"
: >"$ROOT/ideas/collide.goal" # a FILE where the folder should be
: >"$ROOT/ideas/nested/deep.md"
mkdir -p "$ROOT/ideas/plain"

# --------------------------------------------------------------------------
# 1. Happy path — X.md resolves to a sibling X.goal
# --------------------------------------------------------------------------

assert_ok "happy/sibling-resolved" "$ROOT/ideas/X.goal" "$ROOT/ideas/X.md"

assert_ok "happy/nested-sibling" "$ROOT/ideas/nested/deep.goal" \
	"$ROOT/ideas/nested/deep.md"

# The resolver is pure: resolution alone must not create anything.
if [ -e "$ROOT/ideas/X.goal" ]; then
	fail "happy/resolution-is-pure" "resolution created $ROOT/ideas/X.goal"
else
	pass "happy/resolution-is-pure"
fi

# --ensure actually creates it, and is idempotent.
assert_ok "happy/ensure-creates" "$ROOT/ideas/X.goal" --ensure "$ROOT/ideas/X.md"
if [ -d "$ROOT/ideas/X.goal" ]; then
	pass "happy/ensure-created-directory"
else
	fail "happy/ensure-created-directory" "directory absent after --ensure"
fi
assert_ok "happy/ensure-idempotent" "$ROOT/ideas/X.goal" --ensure "$ROOT/ideas/X.md"

# Relative input resolves to the same absolute sibling (folder moves as a unit
# only if resolution never depends on the caller's cwd).
if (
	cd "$ROOT/ideas" || exit 1
	relative_out="$(bash "$RESOLVER" "X.md" 2>/dev/null)"
	[ "$relative_out" = "$ROOT/ideas/X.goal" ]
); then
	pass "happy/relative-input-same-result"
else
	fail "happy/relative-input-same-result" \
		"relative input did not resolve to $ROOT/ideas/X.goal"
fi

# --------------------------------------------------------------------------
# 2. Invalid input
# --------------------------------------------------------------------------

assert_fails "invalid/no-extension" 2 "$ROOT/ideas/noext"

# Several dots: only the FINAL extension is stripped.
assert_ok "invalid/multiple-dots-strips-last-only" "$ROOT/ideas/a.b.goal" \
	"$ROOT/ideas/a.b.md"

assert_fails "invalid/unknown-option" 64 --bogus "$ROOT/ideas/X.md"
assert_fails "invalid/too-many-arguments" 64 "$ROOT/ideas/X.md" "$ROOT/ideas/a.b.md"
assert_fails "invalid/missing-file" 3 "$ROOT/ideas/does-not-exist.md"

# --------------------------------------------------------------------------
# 3. Boundary
# --------------------------------------------------------------------------

# A document already named X.goal.md — the .goal stem is reserved.
assert_fails "boundary/reserved-goal-stem" 2 "$ROOT/ideas/X.goal.md"

# An existing X.goal that is a FILE, not a directory — explicit collision.
assert_fails "boundary/collision-target-is-file" 4 --ensure "$ROOT/ideas/collide.md"

# Pure resolution still reports the path for that collision case (the collision
# is a creation-time fact), but must never claim the folder is usable.
assert_ok "boundary/collision-resolves-but-does-not-create" \
	"$ROOT/ideas/collide.goal" "$ROOT/ideas/collide.md"
if [ -f "$ROOT/ideas/collide.goal" ]; then
	pass "boundary/collision-file-untouched"
else
	fail "boundary/collision-file-untouched" "colliding file was replaced or removed"
fi

# --------------------------------------------------------------------------
# 4. Empty / null
# --------------------------------------------------------------------------

assert_fails "empty/empty-path" 2 ""
assert_fails "empty/no-argument" 64
assert_fails "empty/path-is-a-directory" 3 "$ROOT/ideas/plain"

# --------------------------------------------------------------------------
# 5. Error propagation — unwritable parent directory
# --------------------------------------------------------------------------

mkdir -p "$ROOT/locked"
: >"$ROOT/locked/Y.md"
chmod a-w "$ROOT/locked"

if [ -w "$ROOT/locked" ]; then
	# Running as root (or on a filesystem ignoring the mode): the precondition
	# for this test cannot be established, so it must not be reported as passed.
	fail "error/unwritable-parent-propagates" \
		"precondition unmet: $ROOT/locked still writable (running as root?)"
else
	assert_fails "error/unwritable-parent-propagates" 5 --ensure "$ROOT/locked/Y.md"
fi
chmod u+w "$ROOT/locked"

# --------------------------------------------------------------------------
# 6. Security boundaries — `..` must not escape the parent
# --------------------------------------------------------------------------

# `..` collapses against the document's real directory; the goal folder stays a
# sibling of the document rather than landing anywhere above it.
assert_ok "security/dotdot-collapses-to-sibling" "$ROOT/ideas/X.goal" \
	"$ROOT/ideas/nested/../X.md"

assert_ok "security/dotdot-nested-still-sibling" "$ROOT/ideas/nested/deep.goal" \
	"$ROOT/ideas/./nested/../nested/deep.md"

# The resolved folder must always live inside the document's own directory.
escape_out="$(bash "$RESOLVER" "$ROOT/ideas/nested/../../ideas/X.md" 2>/dev/null)"
case "$escape_out" in
"$ROOT/ideas/"*) pass "security/never-escapes-document-directory" ;;
*) fail "security/never-escapes-document-directory" "resolved outside $ROOT/ideas: [$escape_out]" ;;
esac

# A doc literally named `..md` yields the degenerate stem `.`, which would name a
# folder reading as a traversal segment. It is rejected outright.
: >"$ROOT/ideas/..md"
assert_fails "security/degenerate-dot-stem-rejected" 2 "$ROOT/ideas/..md"

# --------------------------------------------------------------------------
# 6b. The folder MOVES AS A UNIT — §4's whole point
#
# "Every reference between artefacts is relative" is only a claim until a folder
# is actually relocated and its references still resolve. An absolute path, or
# one reaching up out of the folder, survives every other test in this file and
# breaks the moment the workstream is moved, renamed, or archived.
# --------------------------------------------------------------------------

MOVE_SRC="$ROOT/movable"
mkdir -p -- "$MOVE_SRC"
: >"$MOVE_SRC/W.md"
MOVED_FOLDER="$(bash "$RESOLVER" --ensure "$MOVE_SRC/W.md")"

# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf '# Charter\n\nContract: [`./ACs.md`](./ACs.md)\nSpec: [`./spec/spec.md`](./spec/spec.md)\n' >"$MOVED_FOLDER/goal.md"
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf -- '- [ ] a thing — `run.sh`\n      - explanation: no.\n' >"$MOVED_FOLDER/ACs.md"
mkdir -p -- "$MOVED_FOLDER/spec"
printf 'the spec\n' >"$MOVED_FOLDER/spec/spec.md"
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
# In a SUBFOLDER: §4 allows `../ACs.md` only from one level down. At the folder
# root that same link escapes the folder, which is the defect this test exists
# to catch — so the fixture has to place it where the contract permits it.
mkdir -p -- "$MOVED_FOLDER/journal"
# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
printf '# Journal\n\nUp to [`../ACs.md`](../ACs.md)\n' >"$MOVED_FOLDER/journal/entry.md"

# No reference inside the folder may be absolute, or reach outside it.
ABSOLUTE=0
ESCAPING=0
SCANNED=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	SCANNED=$((SCANNED + 1))
	grep -oE '\]\([^)]*\)' "$f" 2>/dev/null | sed 's/^](//; s/)$//' | while IFS= read -r link; do
		case "$link" in
		/*) printf 'ABSOLUTE %s -> %s\n' "$f" "$link" ;;
		../../*) printf 'ESCAPING %s -> %s\n' "$f" "$link" ;;
		esac
	done
done < <(find "$MOVED_FOLDER" -type f -name '*.md') >"$ROOT/link-report.txt"
# `grep -c` already prints 0 when it matches nothing, and its non-zero exit
# then fired the fallback too — producing "0\n0", which equals neither 0 nor
# anything else. Count the lines instead.
ABSOLUTE="$(grep -c ABSOLUTE "$ROOT/link-report.txt" 2>/dev/null | head -1)"
ESCAPING="$(grep -c ESCAPING "$ROOT/link-report.txt" 2>/dev/null | head -1)"
[ -n "$ABSOLUTE" ] || ABSOLUTE=0
[ -n "$ESCAPING" ] || ESCAPING=0

assert_equals "move/no-absolute-internal-references" "0" "$ABSOLUTE"
assert_equals "move/no-references-escaping-the-folder" "0" "$ESCAPING"
if [ "$SCANNED" -ge 2 ]; then
	pass "move/references-were-actually-scanned ($SCANNED)"
else
	fail "move/references-were-actually-scanned" "only $SCANNED file(s) scanned; the zeros above prove nothing"
fi

# Now MOVE it — to a different parent, under a different name — and resolve
# every internal reference from its new location.
MOVE_DEST="$ROOT/relocated/deeper"
mkdir -p -- "$MOVE_DEST"
mv -- "$MOVED_FOLDER" "$MOVE_DEST/W.goal"

BROKEN=0
RESOLVED=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	dir="$(dirname -- "$f")"
	while IFS= read -r link; do
		[ -n "$link" ] || continue
		case "$link" in
		http*) continue ;;
		esac
		RESOLVED=$((RESOLVED + 1))
		if [ ! -e "$dir/$link" ]; then
			printf '        broken after move: %s -> %s\n' "$f" "$link"
			BROKEN=$((BROKEN + 1))
		fi
	done <<LINKEOF
$(grep -oE '\]\([^)]*\)' "$f" 2>/dev/null | sed 's/^](//; s/)$//')
LINKEOF
done <<FILEEOF
$(find "$MOVE_DEST/W.goal" -type f -name '*.md')
FILEEOF

assert_equals "move/every-reference-resolves-after-the-move" "0" "$BROKEN"
if [ "$RESOLVED" -ge 3 ]; then
	pass "move/references-were-actually-resolved ($RESOLVED)"
else
	fail "move/references-were-actually-resolved" "only $RESOLVED link(s) checked; the zero above proves nothing"
fi

# The moved folder is still a usable goal folder: the parser reads its criteria
# from the new location with nothing re-pointed by hand.
assert_equals "move/criteria-still-parse-from-the-new-location" "1" \
	"$(bash "${TEST_DIR}/../parse-acs.sh" "$MOVE_DEST/W.goal/ACs.md" 2>/dev/null | sed -n 's/^total=//p')"

# --------------------------------------------------------------------------
# 7. Contract document exists and states the load-bearing rules
# --------------------------------------------------------------------------

CONTRACT="${TEST_DIR}/../../eque2-code-prepare-goal/references/goal-folder.md"
if [ -f "$CONTRACT" ]; then
	pass "contract/document-present"
	for token in "X.goal" "goal.md" "ACs.md" "relative" "collision"; do
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

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
