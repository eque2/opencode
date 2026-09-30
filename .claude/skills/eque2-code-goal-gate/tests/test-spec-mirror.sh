#!/usr/bin/env bash
# shellcheck disable=SC2016
# Backticks in this file are LITERAL manifest markup being grepped for — a
# labelled source block is written `**Source \`epic-a\`:**` — never command
# substitution. Single quotes are therefore correct and deliberate; expanding
# them would search for something the manifest never contains.
#
# test-spec-mirror.sh — the SPEC mirror and its manifest (T4.6).
#
# The mirror is what makes X.goal/ self-contained and movable. It is also the
# one place this feature is allowed to record a path pointing OUT of the folder,
# so the manifest carries a claim about the world: "these copies came from
# there". A mirror that lies is worse than no mirror, because a reader of
# `spec/` believes they are reading what the build ran against.
#
# So drift is REPORTED, never repaired silently — a copy that no longer matches
# its source is a question about which one is current, and overwriting destroys
# the evidence needed to answer it.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MIRROR="${TEST_DIR}/../mirror-spec.sh"

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

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'cannot create a work directory\n' >&2
	exit 1
}
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

RUN_OUT=""
RUN_RC=0
run() {
	RUN_OUT="$(bash "$MIRROR" "$@" 2>&1)"
	RUN_RC=$?
}

# new_goal <name> — a prepared goal folder.
new_goal() {
	local f="$WORK_DIR/$1.goal"
	mkdir -p -- "$f"
	printf '# charter\n' >"$f/goal.md"
	# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
	printf -- '- [ ] a — `x`\n      - explanation: no.\n' >"$f/ACs.md"
	printf '%s' "$f"
}

# new_pipeline <name> — a pipeline output directory with nested artefacts.
new_pipeline() {
	local p="$WORK_DIR/$1"
	mkdir -p -- "$p/journal" "$p/state/snapshots" "$p/journal/task" "$p/journal/transcripts"
	printf 'the spec\n' >"$p/spec.md"
	printf '{"a":1}\n' >"$p/definitions.json"
	printf 'entry\n' >"$p/journal/T1.md"
	printf 'runtime\n' >"$p/state/snapshots/T1.json"
	printf 'runtime\n' >"$p/.state-events.jsonl"
	printf 'runtime\n' >"$p/.signer-key"
	printf 'runtime\n' >"$p/journal/task/T1.md"
	printf 'runtime\n' >"$p/journal/transcripts/T1.md"
	printf '%s' "$p"
}

# --------------------------------------------------------------------------
# 1. Happy path — the folder becomes self-contained, and says where from
# --------------------------------------------------------------------------

G="$(new_goal happy)"
P="$(new_pipeline pipeline-happy)"

run mirror "$G" "$P"
assert_equals "happy/mirrors" "0" "$RUN_RC"

for f in spec.md definitions.json journal/T1.md; do
	if [ -f "$G/spec/$f" ]; then
		pass "happy/mirrored-$(printf '%s' "$f" | tr '/.' '--')"
	else
		fail "happy/mirrored-$(printf '%s' "$f" | tr '/.' '--')" "missing $G/spec/$f"
	fi
done

assert_equals "happy/content-is-identical" "the spec" "$(cat "$G/spec/spec.md")"

if [ -f "$G/MANIFEST.md" ]; then
	pass "happy/manifest-written"
else
	fail "happy/manifest-written" "no manifest"
fi

# The manifest must name the CANONICAL path of each copy — that is the whole
# point of it existing rather than the copies simply being there.
for f in spec.md definitions.json journal/T1.md; do
	if grep -qF -- "$P/$f" "$G/MANIFEST.md"; then
		pass "manifest/names-source-of-$(printf '%s' "$f" | tr '/.' '--')"
	else
		fail "manifest/names-source-of-$(printf '%s' "$f" | tr '/.' '--')" "the manifest does not record $P/$f"
	fi
done

if grep -qi "authoritative" "$G/MANIFEST.md"; then
	pass "manifest/states-which-copy-wins"
else
	fail "manifest/states-which-copy-wins" "the manifest does not say the pipeline path stays authoritative"
fi

run verify "$G"
assert_equals "happy/verifies-clean" "0" "$RUN_RC"

# Runtime state is created beneath the mirrored spec folder while the goal is
# running. It is not a create-spec artefact, so it must neither be mirrored
# from the pipeline nor make a restart look like specification drift. A normal
# source-authored journal entry remains part of the contract.
if [ ! -e "$G/spec/state/snapshots/T1.json" ] && [ ! -e "$G/spec/.state-events.jsonl" ] && [ ! -e "$G/spec/journal/task/T1.md" ]; then
	pass "runtime/source-runtime-is-not-mirrored"
else
	fail "runtime/source-runtime-is-not-mirrored" "runtime files from the pipeline entered the mirror"
fi
mkdir -p -- "$G/spec/state/snapshots" "$G/spec/journal/task" "$G/spec/journal/transcripts"
printf 'runtime\n' >"$G/spec/state/snapshots/T1.json"
printf 'runtime\n' >"$G/spec/.state-events.jsonl"
printf 'runtime\n' >"$G/spec/.signer-key"
printf 'runtime\n' >"$G/spec/journal/task/T1.md"
printf 'runtime\n' >"$G/spec/journal/transcripts/T1.md"
run verify "$G"
assert_equals "runtime/goal-runtime-does-not-drift" "0" "$RUN_RC"
printf 'tampered source journal\n' >"$G/spec/journal/T1.md"
run verify "$G"
assert_equals "runtime/source-journal-still-drifts" "4" "$RUN_RC"
case "$RUN_OUT" in
*"spec/journal/T1.md"*) pass "runtime/source-journal-is-named" ;;
*) fail "runtime/source-journal-is-named" "ordinary source journal drift was not reported: [$RUN_OUT]" ;;
esac
run mirror "$G" "$P"
assert_equals "runtime/reset-before-drift-cases" "0" "$RUN_RC"

# --------------------------------------------------------------------------
# 2. Invalid input — a drifted copy is REPORTED, not repaired
# --------------------------------------------------------------------------

printf 'somebody edited the mirror\n' >"$G/spec/spec.md"
run verify "$G"
assert_equals "drift/reported" "4" "$RUN_RC"
case "$RUN_OUT" in
*DRIFT*) pass "drift/names-the-drifted-file" ;;
*) fail "drift/names-the-drifted-file" "no DRIFT report: [$RUN_OUT]" ;;
esac
assert_equals "drift/not-silently-repaired" "somebody edited the mirror" "$(cat "$G/spec/spec.md")"
assert_equals "drift/source-untouched" "the spec" "$(cat "$P/spec.md")"

# A drifted SOURCE is equally reported — drift has two directions.
#
# The reset is CHECKED: an unchecked `run mirror` that failed would leave the
# previously drifted copy in place, and the exit 4 below would arrive for the
# wrong reason.
run mirror "$G" "$P"
assert_equals "drift/reset-before-source-case" "0" "$RUN_RC"
printf 'the spec, revised upstream\n' >"$P/spec.md"
run verify "$G"
assert_equals "drift/source-side-reported" "4" "$RUN_RC"

# A mirrored copy with no source at all.
run mirror "$G" "$P"
assert_equals "drift/reset-before-orphan-case" "0" "$RUN_RC"
printf 'orphan\n' >"$G/spec/not-from-the-pipeline.md"
run verify "$G"
assert_equals "drift/orphan-copy-reported" "4" "$RUN_RC"
case "$RUN_OUT" in
*"no source"*) pass "drift/orphan-explains-itself" ;;
*) fail "drift/orphan-explains-itself" "an orphaned copy was not explained: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 3. Boundary — no artefacts, and a pipeline path that does not exist
# --------------------------------------------------------------------------

G2="$(new_goal empty-pipeline)"
EMPTY="$WORK_DIR/empty-pipeline-dir"
mkdir -p -- "$EMPTY"

run mirror "$G2" "$EMPTY"
assert_equals "boundary/no-artefacts-refused" "3" "$RUN_RC"
if [ -e "$G2/spec" ] || [ -e "$G2/MANIFEST.md" ]; then
	fail "boundary/no-artefacts-writes-nothing" "an empty mirror or manifest was written anyway"
else
	pass "boundary/no-artefacts-writes-nothing"
fi

run mirror "$G2" "$WORK_DIR/does-not-exist"
assert_equals "boundary/absent-pipeline-refused" "3" "$RUN_RC"
if [ -e "$G2/MANIFEST.md" ]; then
	fail "boundary/absent-pipeline-writes-nothing" "a manifest was written for a pipeline that does not exist"
else
	pass "boundary/absent-pipeline-writes-nothing"
fi

# A re-mirror REPLACES rather than merges: a stale artefact from a previous
# pipeline run must not sit beside the current ones, indistinguishable.
G3="$(new_goal remirror)"
P3="$(new_pipeline pipeline-remirror)"
run mirror "$G3" "$P3"
rm -f -- "$P3/definitions.json"
run mirror "$G3" "$P3"
if [ -e "$G3/spec/definitions.json" ]; then
	fail "boundary/remirror-replaces" "a stale artefact survived a re-mirror"
else
	pass "boundary/remirror-replaces"
fi
run verify "$G3"
assert_equals "boundary/remirror-verifies-clean" "0" "$RUN_RC"

# --------------------------------------------------------------------------
# 4. Empty/Null — an empty or absent manifest is invalid
# --------------------------------------------------------------------------

G4="$(new_goal manifestless)"
P4="$(new_pipeline pipeline-manifestless)"
run mirror "$G4" "$P4"

rm -f -- "$G4/MANIFEST.md"
run verify "$G4"
assert_equals "empty/absent-manifest-invalid" "2" "$RUN_RC"

: >"$G4/MANIFEST.md"
run verify "$G4"
assert_equals "empty/empty-manifest-invalid" "2" "$RUN_RC"
case "$RUN_OUT" in
*"empty manifest is invalid"*) pass "empty/manifest-explains-why" ;;
*) fail "empty/manifest-explains-why" "no explanation for an empty manifest: [$RUN_OUT]" ;;
esac

run verify "$WORK_DIR"
assert_equals "empty/not-a-goal-folder-refused" "2" "$RUN_RC"

# --------------------------------------------------------------------------
# 5. Error propagation — an unreadable source is reported, not skipped
# --------------------------------------------------------------------------

G5="$(new_goal unreadable)"
P5="$(new_pipeline pipeline-unreadable)"
run mirror "$G5" "$P5"

# The canonical source disappearing is a REPORTED inability to verify, never a
# clean verify over a mirror nothing can vouch for.
mv -- "$P5" "$WORK_DIR/pipeline-moved"
run verify "$G5"
assert_equals "error/absent-source-reported" "3" "$RUN_RC"
case "$RUN_OUT" in
*"no longer exists"*) pass "error/absent-source-explains-itself" ;;
*) fail "error/absent-source-explains-itself" "no explanation: [$RUN_OUT]" ;;
esac

if [ "$(id -u)" -eq 0 ]; then
	pass "error/unreadable-pipeline-reported"
else
	G6="$(new_goal locked)"
	P6="$(new_pipeline pipeline-locked)"
	chmod 000 "$P6"
	run mirror "$G6" "$P6"
	if [ "$RUN_RC" -eq 0 ]; then
		fail "error/unreadable-pipeline-reported" "an unreadable pipeline mirrored successfully"
	else
		pass "error/unreadable-pipeline-reported"
	fi
	# The MESSAGE, not just a non-zero code: mirror-spec exits 3 for both
	# "unreadable" and "holds no files", so an implementation that silently read
	# an unreadable directory as empty would satisfy the exit code while
	# reporting the opposite of what happened.
	case "$RUN_OUT" in
	*"not readable"*) pass "error/unreadable-says-unreadable-not-empty" ;;
	*) fail "error/unreadable-says-unreadable-not-empty" "an unreadable pipeline was reported as something else: [$RUN_OUT]" ;;
	esac
	chmod 700 "$P6"
fi

# An EMPTY mirror is invalid input (exit 2), not phantom drift. The verify loop
# used a here-doc, which always yields one line, so an empty spec/ entered the
# loop once with an empty filename and reported DRIFT — the wrong exit code for
# the wrong reason, and the "mirror holds no files" branch was unreachable.
G7="$(new_goal emptymirror)"
P7="$(new_pipeline pipeline-emptymirror)"
run mirror "$G7" "$P7"
rm -rf -- "$G7/spec"
mkdir -p -- "$G7/spec"
run verify "$G7"
assert_equals "empty/empty-mirror-is-invalid-not-drift" "2" "$RUN_RC"

# A file ADDED to the source after mirroring makes the mirror incomplete.
# Walking copy->source alone could never see it, so verify reported "no drift"
# over a materially incomplete mirror — the worst answer available for a thing
# whose whole purpose is to be trusted as a faithful copy.
G8="$(new_goal addedfile)"
P8="$(new_pipeline pipeline-addedfile)"
run mirror "$G8" "$P8"
assert_equals "drift/clean-before-source-addition" "0" "$RUN_RC"
printf 'a new artefact the pipeline emitted later\n' >"$P8/scenarios.md"
run verify "$G8"
assert_equals "drift/source-addition-reported" "4" "$RUN_RC"
case "$RUN_OUT" in
*"the mirror does not"*) pass "drift/addition-explains-itself" ;;
*) fail "drift/addition-explains-itself" "an incomplete mirror was not explained: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 5b. Multi-epic goals: one spec/<slug>/ subtree per source (DEFECT
#     goal-gate-mirror-spec-single-epic-only). A two-epic goal has two
#     canonical sources; the single-**Source:** manifest could not represent
#     it, so verify refused a legitimate folder.
# --------------------------------------------------------------------------

GM="$(new_goal multi)"
PA="$(new_pipeline pipeline-epicA)"
PB="$WORK_DIR/pipeline-epicB"
mkdir -p -- "$PB/docs"
printf 'epic B spec\n' >"$PB/spec.md"
printf 'a doc\n' >"$PB/docs/install.md"

run mirror "$GM" "epic-a=$PA" "epic-b=$PB"
assert_equals "multi/mirror-succeeds" "0" "$RUN_RC"
# Each source lands under its own subtree, and nothing lands flat.
#
# An `if` rather than `A && B && pass || fail`: in that form the `||` also fires
# when `pass` itself fails, so a passing test can report a failure (SC2015).
if [ -f "$GM/spec/epic-a/spec.md" ] && [ -f "$GM/spec/epic-b/docs/install.md" ]; then
	pass "multi/subtrees-per-source"
else
	fail "multi/subtrees-per-source" "expected spec/epic-a and spec/epic-b subtrees"
fi
# The manifest records a labelled block per source, not a single **Source:**.
if grep -q '^\*\*Source `epic-a`:\*\*' "$GM/MANIFEST.md" &&
	grep -q '^\*\*Source `epic-b`:\*\*' "$GM/MANIFEST.md" &&
	! grep -q '^\*\*Source:\*\*' "$GM/MANIFEST.md"; then
	pass "multi/manifest-labelled-blocks"
else
	fail "multi/manifest-labelled-blocks" "manifest is not multi-source: [$(cat "$GM/MANIFEST.md")]"
fi

run verify "$GM"
assert_equals "multi/verify-clean" "0" "$RUN_RC"

# Drift in ONE subtree is caught and named with its slug.
printf 'tampered\n' >"$GM/spec/epic-a/spec.md"
run verify "$GM"
assert_equals "multi/subtree-drift-caught" "4" "$RUN_RC"
case "$RUN_OUT" in
*"spec/epic-a/spec.md"*) pass "multi/subtree-drift-names-slug" ;;
*) fail "multi/subtree-drift-names-slug" "drift not attributed to its subtree: [$RUN_OUT]" ;;
esac

# A file added to ONE source is seen against its own subtree.
GM2="$(new_goal multi2)"
PA2="$(new_pipeline pipeline-epicA2)"
PB2="$WORK_DIR/pipeline-epicB2"
mkdir -p -- "$PB2"
printf 'b\n' >"$PB2/spec.md"
run mirror "$GM2" "a=$PA2" "b=$PB2"
assert_equals "multi/added-clean-before" "0" "$RUN_RC"
printf 'later\n' >"$PB2/scenarios.md"
run verify "$GM2"
assert_equals "multi/added-file-in-subtree-caught" "4" "$RUN_RC"
case "$RUN_OUT" in
*"b/scenarios.md"*) pass "multi/added-file-names-subtree" ;;
*) fail "multi/added-file-names-subtree" "added source file not attributed to its subtree: [$RUN_OUT]" ;;
esac

# A stray file at the top of spec/ belongs to no declared subtree -> drift.
GM3="$(new_goal multi3)"
PA3="$(new_pipeline pipeline-epicA3)"
PB3="$WORK_DIR/pipeline-epicB3"
mkdir -p -- "$PB3"
printf 'b\n' >"$PB3/spec.md"
run mirror "$GM3" "a=$PA3" "b=$PB3"
printf 'orphan\n' >"$GM3/spec/loose.md"
run verify "$GM3"
assert_equals "multi/stray-top-level-is-drift" "4" "$RUN_RC"

# Mixed forms are refused: a bare path beside a labelled one has no subtree.
GM4="$(new_goal multi4)"
PA4="$(new_pipeline pipeline-epicA4)"
PB4="$(new_pipeline pipeline-epicB4)"
run mirror "$GM4" "a=$PA4" "$PB4"
assert_equals "multi/mixed-forms-refused" "2" "$RUN_RC"

# Two bare paths (unlabelled) are refused: which subtree does each go to?
run mirror "$GM4" "$PA4" "$PB4"
assert_equals "multi/two-bare-paths-refused" "2" "$RUN_RC"

# A bad slug (path traversal) is refused before any path is composed.
run mirror "$GM4" "../evil=$PA4"
assert_equals "multi/bad-slug-refused" "2" "$RUN_RC"

# Duplicate slugs would silently overwrite one subtree with the other.
run mirror "$GM4" "dup=$PA4" "dup=$PB4"
assert_equals "multi/duplicate-slug-refused" "2" "$RUN_RC"

# A manifest carrying BOTH forms is ambiguous and refused at verify.
GM5="$(new_goal multi5)"
PA5="$(new_pipeline pipeline-epicA5)"
run mirror "$GM5" "a=$PA5"
# shellcheck disable=SC2016  # writing a literal **Source:** line into the manifest
printf '**Source:** `%s`\n' "$PA5" >>"$GM5/MANIFEST.md"
run verify "$GM5"
assert_equals "multi/mixed-manifest-refused" "2" "$RUN_RC"

# --------------------------------------------------------------------------
# 6. in-place — the DEFAULT: spec/ is its own canonical source
#
# The spec pipeline is pointed at X.goal/spec/ and writes there, so nothing is
# left in _bmad-output/ and there is no copy→source comparison to make. The
# manifest still gets written, because a spec/ whose origin nothing states is
# exactly what pursue-goal refuses.
# --------------------------------------------------------------------------

GI1="$(new_goal inplace1)"
mkdir -p -- "$GI1/spec"
printf 'the spec\n' >"$GI1/spec/spec.md"
printf '{"a":1}\n' >"$GI1/spec/definitions.json"

run in-place "$GI1"
assert_equals "in-place/records-succeeds" "0" "$RUN_RC"
if grep -qF 'in place' "$GI1/MANIFEST.md" 2>/dev/null; then
	pass "in-place/manifest-says-in-place"
else
	fail "in-place/manifest-says-in-place" "MANIFEST.md does not record the in-place claim"
fi
if grep -q '^\*\*Source:\*\*' "$GI1/MANIFEST.md" 2>/dev/null; then
	fail "in-place/no-external-source" "an in-place manifest must name no external source"
else
	pass "in-place/no-external-source"
fi

run verify "$GI1"
assert_equals "in-place/verify-clean" "0" "$RUN_RC"

# An in-place manifest over an empty spec/ is the same lie an empty mirror is.
rm -f -- "$GI1/spec/spec.md" "$GI1/spec/definitions.json"
run verify "$GI1"
assert_equals "in-place/empty-spec-is-invalid" "2" "$RUN_RC"

# Recording in-place with no spec/ at all asserts a spec that does not exist.
GI2="$(new_goal inplace2)"
run in-place "$GI2"
assert_equals "in-place/absent-spec-refused" "3" "$RUN_RC"

# Both claims at once is ambiguous, so it is refused rather than resolved.
GI3="$(new_goal inplace3)"
mkdir -p -- "$GI3/spec"
printf 'the spec\n' >"$GI3/spec/spec.md"
run in-place "$GI3"
PI3="$(new_pipeline pipeline-inplace3)"
# shellcheck disable=SC2016  # writing a literal **Source:** line into the manifest
printf '**Source:** `%s`\n' "$PI3" >>"$GI3/MANIFEST.md"
run verify "$GI3"
assert_equals "in-place/mixed-claims-refused" "2" "$RUN_RC"

# --------------------------------------------------------------------------
# 7. The contract documents both forms
# --------------------------------------------------------------------------

CONTRACT="${TEST_DIR}/../../eque2-code-prepare-goal/references/goal-folder.md"
for token in "MANIFEST" "mirror" "authoritative" "in place" "in-place"; do
	if grep -qi -- "$token" "$CONTRACT" 2>/dev/null; then
		pass "contract/states-$token"
	else
		fail "contract/states-$token" "goal-folder.md does not mention '$token'"
	fi
done

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
