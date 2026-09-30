#!/usr/bin/env bash
# test-spec-in-folder.sh — the workstream's documents live in the workstream's
# folder, and that is ENFORCED rather than merely instructed.
#
# goal-folder.md §2: "No artefact produced for the workstream may be written
# outside `X.goal/`, with the single named exception in §5." §5 is the SPEC: the
# create-spec pipeline owns its output path, so prepare-goal mirrors the result
# into `X.goal/spec/` with `MANIFEST.md` recording the provenance.
#
# THE FIELD FAILURE THIS PINS. The mirror step was prose in phases.md and
# enforced by nothing, so a run invoked the spec pipeline, left `spec.md` in the
# pipeline's own output directory, and finished with a goal folder that was not
# self-contained. Nothing noticed. Prose an agent can skip is not a contract.
#
# The asymmetry below is deliberate and is the whole design:
#   - a mirror that is WRONG (no provenance, dead source, drifted) is REFUSED
#   - NOTHING AT ALL is REPORTED, not refused, because "no spec was ever
#     produced" and "a spec was produced elsewhere" are indistinguishable from
#     here, and refusing would break every folder prepared before this existed.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PURSUE="${TEST_DIR}/../pursue-goal.sh"
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

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'FAIL  could not create a work directory\n'
	exit 1
}

# new_goal <name> — a prepared folder with one unmet criterion. Echoes the path.
new_goal() {
	local d="$WORK_DIR/$1"
	mkdir -p "$d/demo.goal"
	cat >"$d/demo.goal/goal.md" <<'MD'
# Demo
Criteria: `ACs.md`
MD
	cat >"$d/demo.goal/ACs.md" <<'MD'
# Done when

- [ ] **CRITICAL** The marker exists — `artifact.txt`
  - explanation: not created yet
MD
	printf '%s' "$d/demo.goal"
}

# start <folder> — run the starter. Sets OUT (its stderr) and START_RC.
#
# Deliberately NOT `OUT="$(start …)"`: that runs the function in a SUBSHELL, so
# its assignment to START_RC is discarded and every exit-code assertion silently
# reads 0. Cost an hour the first time; the stderr goes to a file instead.
START_RC=0
OUT=""
start() {
	local folder="$1"
	START_RC=0
	(cd "$(dirname -- "$folder")" &&
		env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
			bash "$PURSUE" "$folder") >/dev/null 2>"$WORK_DIR/last.err" || START_RC=$?
	OUT="$(cat "$WORK_DIR/last.err" 2>/dev/null)"
}

# state_count <folder> — how many files the gate directory holds. A refusal must
# leave NOTHING behind; that is pursue-goal's stated contract.
state_count() {
	local d n=0 f
	d="$(dirname -- "$1")/.goal-gate"
	[ -d "$d" ] || {
		printf '0'
		return 0
	}
	for f in "$d"/* "$d"/.[!.]*; do
		[ -e "$f" ] && n=$((n + 1))
	done
	printf '%s' "$n"
}

# --- 1. a mirror with no provenance is refused ------------------------------

G="$(new_goal noprov)"
mkdir -p "$G/spec"
printf 'the spec\n' >"$G/spec/spec.md"
start "$G"

case "$OUT" in
*"no MANIFEST.md"*) pass "noprovenance/refused-and-says-why" ;;
*) fail "noprovenance/refused-and-says-why" "unexpected: [$OUT]" ;;
esac
if [ "$START_RC" -ne 0 ]; then
	pass "noprovenance/exits-non-zero"
else
	fail "noprovenance/exits-non-zero" "a spec with no provenance was accepted"
fi
if [ "$(state_count "$G")" = "0" ]; then
	pass "noprovenance/writes-no-loop-state"
else
	fail "noprovenance/writes-no-loop-state" "a refusal left loop state behind"
fi

# --- 2. a manifest whose source has vanished is refused ---------------------

G="$(new_goal gone)"
mkdir -p "$G/spec"
printf 'the spec\n' >"$G/spec/spec.md"
# shellcheck disable=SC2016  # the manifest format is literal, not an expansion
printf '**Source:** `%s`\n' "$WORK_DIR/never-existed" >"$G/MANIFEST.md"
start "$G"

case "$OUT" in
*"canonical source no longer exists"*) pass "deadsource/refused-and-says-why" ;;
*) fail "deadsource/refused-and-says-why" "unexpected: [$OUT]" ;;
esac
if [ "$(state_count "$G")" = "0" ]; then
	pass "deadsource/writes-no-loop-state"
else
	fail "deadsource/writes-no-loop-state" "a refusal left loop state behind"
fi

# --- 3. a DRIFTED mirror is refused -----------------------------------------
#
# The folder claims a provenance that is no longer true. That is worse than no
# mirror: it reads as self-contained while its spec disagrees with the pipeline.

G="$(new_goal drift)"
PIPE="$WORK_DIR/pipeline-drift"
mkdir -p "$PIPE"
printf 'original\n' >"$PIPE/spec.md"
bash "$MIRROR" mirror "$G" "$PIPE" >/dev/null 2>&1
printf 'CHANGED UNDERNEATH\n' >"$PIPE/spec.md"
start "$G"

case "$OUT" in
*[Dd][Rr][Ii][Ff][Tt]*) pass "drift/refused-and-says-why" ;;
*) fail "drift/refused-and-says-why" "a drifted mirror was accepted or misreported: [$OUT]" ;;
esac
if [ "$(state_count "$G")" = "0" ]; then
	pass "drift/writes-no-loop-state"
else
	fail "drift/writes-no-loop-state" "a refusal left loop state behind"
fi

# --- 4. a real mirror is accepted -------------------------------------------

G="$(new_goal good)"
PIPE="$WORK_DIR/pipeline-good"
mkdir -p "$PIPE"
printf 'the spec\n' >"$PIPE/spec.md"
bash "$MIRROR" mirror "$G" "$PIPE" >/dev/null 2>&1
start "$G"

if [ "$START_RC" -eq 0 ]; then
	pass "mirrored/starts"
else
	fail "mirrored/starts" "a correctly mirrored folder was refused (exit $START_RC): [$OUT]"
fi
case "$OUT" in
*"no spec/"* | *"no MANIFEST"* | *DRIFT*) fail "mirrored/no-spurious-complaint" "[$OUT]" ;;
*) pass "mirrored/no-spurious-complaint" ;;
esac
if [ -f "$G/spec/spec.md" ] && [ -f "$G/MANIFEST.md" ]; then
	pass "mirrored/the-spec-is-IN-the-goal-folder"
else
	fail "mirrored/the-spec-is-IN-the-goal-folder" "spec/ or MANIFEST.md missing from $G"
fi

# --- 5. BACKWARDS COMPATIBILITY: a folder with no spec at all still starts ---
#
# Folders prepared before this check existed carry no spec/ and no MANIFEST.
# Refusing them would strand every in-flight goal. Reported loudly, never fatal.

G="$(new_goal nospec)"
start "$G"

if [ "$START_RC" -eq 0 ]; then
	pass "compat/a-folder-with-no-spec-still-starts"
else
	fail "compat/a-folder-with-no-spec-still-starts" \
		"in-flight goals prepared before this check would be stranded (exit $START_RC)"
fi
case "$OUT" in
*"no spec/ and no MANIFEST"*) pass "compat/but-it-is-reported-loudly" ;;
*) fail "compat/but-it-is-reported-loudly" "silence is how the original bug went unnoticed: [$OUT]" ;;
esac
if [ "$(state_count "$G")" != "0" ]; then
	pass "compat/the-loop-actually-started"
else
	fail "compat/the-loop-actually-started" "reported AND refused — the report was meant to be non-fatal"
fi

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
