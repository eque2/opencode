#!/usr/bin/env bash
# test-prepare-goal-output.sh — conformance suite for the prepare-goal skill's
# OUTPUT SHAPE (T4.1): a self-contained `X.goal/` replacing edit-in-place plus
# scattered `_bmad-output/` locations.
#
# WHAT IS ACTUALLY TESTABLE HERE, stated plainly so nobody mistakes this suite
# for more than it is. `prepare-goal` is a SKILL — prose instructions an agent
# follows — not a program this suite can execute. So there are two halves:
#
#   1. THE RESOLVER. `goal-folder-path.sh` is real code and IS executed here,
#      end to end, for the happy path, the already-prepared case, the
#      non-destructive-reuse boundary, the empty document, and the unwritable
#      target. That is the machinery the skill is instructed to call, so its
#      behaviour under those cases is a genuine executable assertion.
#
#   2. THE INSTRUCTIONS. Whether the skill TELLS the agent to produce `X.goal/`
#      is a property of its text, so the text is what is asserted — exhaustively,
#      across every reference file. The task brief names this as the point: this
#      is the change most likely to leave a stale path behind, and the exhaustive
#      assertion is the guard.
#
# The second half cannot prove an agent obeys the instructions. It proves the
# instructions say the right thing and contain no contradicting leftover. That
# distinction is the honest one, and it is why the live end-to-end behaviour is
# a [live] item in the charter's Done-when checklist rather than something this
# suite silently claims to have covered.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE_DIR="$(cd -- "${TEST_DIR}/.." && pwd -P)"
RESOLVER="${GATE_DIR}/goal-folder-path.sh"
SKILL_DIR="$(cd -- "${GATE_DIR}/../eque2-code-prepare-goal" && pwd -P)"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prepare-goal-output.XXXXXX")"
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

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

# assert_file_mentions <name> <file> <needle>
assert_file_mentions() {
	if grep -qF -- "$3" "$2" 2>/dev/null; then
		pass "$1"
	else
		fail "$1" "$(basename "$2") does not mention [$3]"
	fi
}

printf '== prepare-goal output shape (T4.1) conformance suite ==\n'
printf 'skill:    %s\n' "$SKILL_DIR"
printf 'resolver: %s\n\n' "$RESOLVER"

if [ ! -f "$RESOLVER" ]; then
	printf 'FATAL: resolver not found at %s\n' "$RESOLVER" >&2
	exit 1
fi
if [ ! -d "$SKILL_DIR" ]; then
	printf 'FATAL: prepare-goal skill not found at %s\n' "$SKILL_DIR" >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: X.md yields a sibling X.goal/ ready for artefacts --\n'
# ===========================================================================

mkdir -p "$WORK_DIR/ideas"
printf '# a rough idea\n\nsome prose\n' >"$WORK_DIR/ideas/X.md"

OUT="$(bash "$RESOLVER" --ensure "$WORK_DIR/ideas/X.md" 2>"$WORK_DIR/e1")"
RC=$?
assert_equals "happy/ensure-succeeds" "0" "$RC"
assert_equals "happy/the-folder-is-a-sibling-of-the-document" "$WORK_DIR/ideas/X.goal" "$OUT"

if [ -d "$WORK_DIR/ideas/X.goal" ]; then
	pass "happy/the-folder-exists-on-disk"
else
	fail "happy/the-folder-exists-on-disk" "no directory at $WORK_DIR/ideas/X.goal"
fi

# The charter and the acceptance contract are what the folder is FOR, so the
# folder must be able to receive them. Writing them here is the harness
# standing in for the agent; what is asserted is that the location works.
printf '# charter\n\nsee ./ACs.md\n' >"$WORK_DIR/ideas/X.goal/goal.md" 2>/dev/null
# shellcheck disable=SC2016  # a literal pattern, not an expansion
printf -- '- [ ] **CRITICAL** something holds — `path/to/thing`\n' >"$WORK_DIR/ideas/X.goal/ACs.md" 2>/dev/null
if [ -f "$WORK_DIR/ideas/X.goal/goal.md" ] && [ -f "$WORK_DIR/ideas/X.goal/ACs.md" ]; then
	pass "happy/the-folder-holds-the-charter-and-the-criteria"
else
	fail "happy/the-folder-holds-the-charter-and-the-criteria" "goal.md / ACs.md could not be written"
fi

# The input document is NOT the deliverable any more, and must be left alone.
assert_equals "happy/the-input-document-is-untouched" \
	"$(printf '# a rough idea\n\nsome prose\n')" "$(cat "$WORK_DIR/ideas/X.md")"

# ===========================================================================
printf -- '-- 2. Already prepared: re-resolving is idempotent, never destructive --\n'
# ===========================================================================

OUT2="$(bash "$RESOLVER" --ensure "$WORK_DIR/ideas/X.md" 2>/dev/null)"
assert_equals "prepared/re-resolution-yields-the-same-folder" "$WORK_DIR/ideas/X.goal" "$OUT2"
assert_equals "prepared/existing-content-survives-re-resolution" \
	"# charter" "$(head -1 "$WORK_DIR/ideas/X.goal/goal.md" 2>/dev/null)"

if [ -f "$WORK_DIR/ideas/X.goal/ACs.md" ]; then
	pass "prepared/the-criteria-file-is-not-clobbered"
else
	fail "prepared/the-criteria-file-is-not-clobbered" "ACs.md disappeared on re-resolution"
fi

# A document whose stem is already `.goal` is rejected: deriving X.goal.goal/
# would be ambiguous with an existing goal folder.
printf 'x\n' >"$WORK_DIR/ideas/Y.goal.md"
if bash "$RESOLVER" "$WORK_DIR/ideas/Y.goal.md" >/dev/null 2>&1; then
	fail "prepared/a-reserved-goal-stem-is-rejected" "Y.goal.md was accepted"
else
	pass "prepared/a-reserved-goal-stem-is-rejected"
fi

# ===========================================================================
printf -- '-- 3. Boundary: an existing X.goal that is NOT a directory --\n'
# ===========================================================================

printf 'not a directory\n' >"$WORK_DIR/ideas/Z.md"
printf 'occupied\n' >"$WORK_DIR/ideas/Z.goal"

bash "$RESOLVER" --ensure "$WORK_DIR/ideas/Z.md" >/dev/null 2>"$WORK_DIR/e3"
RC3=$?
if [ "$RC3" -eq 0 ]; then
	fail "boundary/a-file-in-the-way-is-a-failure" "ensure succeeded despite Z.goal being a file"
else
	pass "boundary/a-file-in-the-way-is-a-failure"
fi
assert_equals "boundary/the-occupying-file-is-left-untouched" "occupied" "$(cat "$WORK_DIR/ideas/Z.goal")"
if grep -q 'goal-folder:' "$WORK_DIR/e3" 2>/dev/null; then
	pass "boundary/the-collision-is-reported"
else
	fail "boundary/the-collision-is-reported" "no goal-folder: diagnostic on stderr"
fi

# ===========================================================================
printf -- '-- 4. Empty/Null: an empty idea document still resolves --\n'
# ===========================================================================
#
# Empty content is not invalid input — it is a document with nothing in it yet.
# The failure belongs downstream (the agent has nothing to harden), not here.

: >"$WORK_DIR/ideas/Empty.md"
OUTE="$(bash "$RESOLVER" --ensure "$WORK_DIR/ideas/Empty.md" 2>/dev/null)"
RCE=$?
assert_equals "empty/an-empty-document-resolves" "0" "$RCE"
assert_equals "empty/it-resolves-to-its-own-sibling" "$WORK_DIR/ideas/Empty.goal" "$OUTE"

# A path that does not exist is a different thing entirely, and IS rejected.
if bash "$RESOLVER" "$WORK_DIR/ideas/NoSuch.md" >/dev/null 2>&1; then
	fail "empty/a-missing-document-is-rejected" "a non-existent document was accepted"
else
	pass "empty/a-missing-document-is-rejected"
fi

# ===========================================================================
printf -- '-- 5. Error propagation: reported BEFORE any partial output --\n'
# ===========================================================================

mkdir -p "$WORK_DIR/ro"
printf 'idea\n' >"$WORK_DIR/ro/W.md"
chmod a-w "$WORK_DIR/ro"

if [ -w "$WORK_DIR/ro" ]; then
	pass "errprop/unwritable-parent-is-reported (skipped: running as root)"
	pass "errprop/nothing-partial-was-written (skipped: running as root)"
else
	bash "$RESOLVER" --ensure "$WORK_DIR/ro/W.md" >/dev/null 2>"$WORK_DIR/e5"
	RC5=$?
	if [ "$RC5" -ne 0 ] && grep -q 'goal-folder:' "$WORK_DIR/e5" 2>/dev/null; then
		pass "errprop/unwritable-parent-is-reported"
	else
		fail "errprop/unwritable-parent-is-reported" "rc=$RC5 stderr=[$(cat "$WORK_DIR/e5")]"
	fi

	if [ -e "$WORK_DIR/ro/W.goal" ]; then
		fail "errprop/nothing-partial-was-written" "a partial W.goal was left behind"
	else
		pass "errprop/nothing-partial-was-written"
	fi
fi
chmod u+w "$WORK_DIR/ro"

# ===========================================================================
printf -- '-- 6. The instructions describe the goal-folder output shape --\n'
# ===========================================================================

SKILL="$SKILL_DIR/SKILL.md"
PHASES="$SKILL_DIR/references/phases.md"

assert_file_mentions "instructions/skill-names-the-goal-folder" "$SKILL" 'X.goal/'
assert_file_mentions "instructions/skill-names-the-charter-file" "$SKILL" 'goal.md'
assert_file_mentions "instructions/skill-names-the-criteria-file" "$SKILL" 'ACs.md'
assert_file_mentions "instructions/skill-points-at-the-layout-contract" "$SKILL" 'goal-folder.md'
assert_file_mentions "instructions/phase-E-writes-the-criteria-file" "$PHASES" 'ACs.md'
assert_file_mentions "instructions/phase-E-writes-the-charter" "$PHASES" 'goal.md'
assert_file_mentions "instructions/pre-flight-resolves-the-folder" "$PHASES" 'goal-folder-path.sh'

# The relative-reference rule is what makes the folder movable (S2). If the
# skill does not say it, artefacts will be written with absolute links.
if grep -qiE 'relative' "$SKILL" "$PHASES" 2>/dev/null; then
	pass "instructions/the-relative-reference-rule-is-stated"
else
	fail "instructions/the-relative-reference-rule-is-stated" \
		"neither SKILL.md nor phases.md states that internal references are relative"
fi

# The SPEC mirror is the ONE named exception to containment. If it is not
# stated, either the SPEC gets left scattered or someone "fixes" the pipeline.
if grep -qiE 'mirror' "$SKILL" "$PHASES" 2>/dev/null; then
	pass "instructions/the-spec-mirror-exception-is-stated"
else
	fail "instructions/the-spec-mirror-exception-is-stated" "the §5 SPEC-mirror exception is not described"
fi

# ===========================================================================
printf -- '-- 7. EXHAUSTIVE: no stale scattered-output path survives anywhere --\n'
# ===========================================================================
#
# The guard the task brief asks for. Every file in the skill is swept, not a
# hand-picked few: a stale path in an un-swept reference file is exactly the
# defect this is here to catch, and it would otherwise be found by a user whose
# artefacts silently landed in the old place.
#
# `_bmad-output/features-active/` is NOT swept for: that is the create-spec
# pipeline's own canonical directory, which the goal folder MIRRORS rather than
# replaces (goal-folder.md §5). Sweeping it would forbid describing the very
# exception the contract requires.

STALE_PATTERNS='_bmad-output/journals/|_bmad-output/planning-artifacts/|edits the input file in place|EDITS THE INPUT FILE in place|rewrite the input in place|input file is edited in place'

SWEPT=0
STALE_HITS=""
while IFS= read -r f; do
	SWEPT=$((SWEPT + 1))
	hits="$(grep -nE "$STALE_PATTERNS" "$f" 2>/dev/null || true)"
	if [ -n "$hits" ]; then
		STALE_HITS="${STALE_HITS}
${f}:
${hits}"
	fi
done <<EOF
$(find "$SKILL_DIR" -type f -name '*.md' | sort)
EOF

if [ "$SWEPT" -ge 5 ]; then
	pass "exhaustive/the-sweep-actually-read-the-skill-files ($SWEPT files)"
else
	fail "exhaustive/the-sweep-actually-read-the-skill-files" \
		"only $SWEPT files swept — the sweep is not covering the skill, so a clean result proves nothing"
fi

if [ -z "$STALE_HITS" ]; then
	pass "exhaustive/no-stale-scattered-output-path-remains"
else
	fail "exhaustive/no-stale-scattered-output-path-remains" "stale references:${STALE_HITS}"
fi

# And the positive half: the goal folder is not merely un-contradicted, it is
# actually described somewhere in the skill's own text.
if grep -rqF 'X.goal' "$SKILL_DIR" 2>/dev/null; then
	pass "exhaustive/the-goal-folder-shape-is-described-in-the-skill"
else
	fail "exhaustive/the-goal-folder-shape-is-described-in-the-skill" "no mention of X.goal anywhere"
fi

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
