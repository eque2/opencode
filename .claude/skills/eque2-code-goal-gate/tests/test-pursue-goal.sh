#!/usr/bin/env bash
# test-pursue-goal.sh — suite for the loop starter (T4.4).
#
# The starter is the half a user actually types. Its whole job is to refuse
# convincingly: every failing path here must leave NO loop state behind, because
# state written on a refused start is a loop nothing will ever claim.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
STARTER="${TEST_DIR}/../pursue-goal.sh"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"
FORMAT_CHECK="${TEST_DIR}/../acs-format-check.sh"
CHARTER_CHECK="${TEST_DIR}/../charter-check.sh"
GATE="${TEST_DIR}/../goal-gate-stop.sh"
MERGE_HOOKS="${TEST_DIR}/../../eque2-code-setup/scripts/merge-hooks.py"

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
# Physical resolution up front: on macOS $TMPDIR is a symlink into /private, and
# the starter records physically-resolved paths. Comparing an unresolved fixture
# path against a resolved binding would fail for a reason that is not a defect.
WORK_DIR="$(cd -- "$WORK_DIR" && pwd -P)"

# The fixture has no host agent config, so registration is verified separately
# (§6 below) rather than blocking every other test.
export GOAL_GATE_SKIP_REGISTRATION_CHECK=1
export GOAL_GATE_AGENT=claude

# --- fixtures ---------------------------------------------------------------

# new_anchor <name> — a fresh working tree acting as the session's root.
new_anchor() {
	local a="$WORK_DIR/$1"
	mkdir -p -- "$a"
	printf '%s' "$a"
}

# new_goal <anchor> <name> <acs-body> — a prepared goal folder.
new_goal() {
	local anchor="$1" name="$2" body="$3"
	local f="$anchor/$name.goal"
	mkdir -p -- "$f"
	printf '# %s\n\nCharter.\n' "$name" >"$f/goal.md"
	printf '%s\n' "$body" >"$f/ACs.md"
	printf '%s' "$f"
}

# new_direct_goal <anchor> <name> — a goal contract emitted by the direct
# inline bootstrap. The fixture has no plan or approval marker: it proves that
# the direct route emits the durable resume instructions, validates its charter
# and criteria, then reuses the starter for every hook, lock, and state
# operation.
new_direct_goal() {
	local anchor="$1" name="$2" f=""
	f="$anchor/$name.goal"
	mkdir -p -- "$f"
	printf '# Direct request\n\nPursue the goal of fixing all lint issues.\n' >"$f/prompt.md"
	printf 'mode: direct-inline\nslug: %s\n' "$name" >"$f/DIRECT.md"
	cat >"$f/goal.md" <<'EOF'
> **DIRECT GOAL — resume safely.** This folder is a direct inline contract.
> First inspect the goal-gate status in this checkout. If a loop is active for
> this folder, resume its unchecked criteria. If no loop is active, invoke
> `eque2-code-pursue-goal` on this folder before doing any work. Do not create
> state by hand or work with no bound gate.

# Direct goal

This contract was created from an explicit inline request in the current
checkout. It has no planning or preparation record.

Its provenance is [`./DIRECT.md`](./DIRECT.md). Complete the named work and
run the real repository quality commands before marking criteria met.

## Done when

The acceptance contract is [`./ACs.md`](./ACs.md) (2 criteria). The stop gate
reads that file. This charter does not restate the criteria.
EOF
	cat >"$f/ACs.md" <<'EOF'
> **DIRECT GOAL — resume safely.** This folder is a direct inline contract.
> First inspect the goal-gate status in this checkout. If a loop is active for
> this folder, resume its unchecked criteria. If no loop is active, invoke
> `eque2-code-pursue-goal` on this folder before doing any work. Do not create
> state by hand or work with no bound gate.

# Done when

- [ ] **CRITICAL** The lint script in `package.json` reports no lint issues.
      - explanation: the reported lint issues have not been fixed yet.
- [ ] The project quality scripts declared in `package.json` pass for the
      direct lint-fix goal.
	      - explanation: the quality commands have not run yet.
EOF
	cat >"$f/CLAUDE.md" <<'EOF'
> **DIRECT GOAL — resume safely.** This folder is a direct inline contract.
> First inspect the goal-gate status in this checkout. If a loop is active for
> this folder, resume its unchecked criteria. If no loop is active, invoke
> `eque2-code-pursue-goal` on this folder before doing any work. Do not create
> state by hand or work with no bound gate.
EOF
	cp -- "$f/CLAUDE.md" "$f/AGENTS.md"
	printf '%s' "$f"
}

# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
OUTSTANDING='# Done when

- [ ] The thing works — `run.sh`
      - explanation: not built yet.
- [ ] The other thing works — `run.sh`
      - explanation: not built yet.'

# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
ALL_DONE='# Done when

- [x] The thing works — `run.sh`
      - evidence: `bash run.sh` → exit 0'

# shellcheck disable=SC2016  # a markdown fixture; the backticks are content
ONE_ONLY='# Done when

- [ ] The only thing works — `run.sh`
      - explanation: not built yet.'

# run <anchor> <args...> — invoke the starter with that anchor. Captures
# stdout+stderr in RUN_OUT and the status in RUN_RC.
RUN_OUT=""
RUN_RC=0
run() {
	local anchor="$1"
	shift
	RUN_OUT="$(GOAL_GATE_ANCHOR="$anchor" bash "$STARTER" "$@" 2>&1)"
	RUN_RC=$?
}

# state_files <anchor> — how many loop state files exist.
state_files() {
	local n=0 f
	for f in "$1"/.goal-gate/*.state; do
		[ -f "$f" ] && n=$((n + 1))
	done
	printf '%d' "$n"
}

# assert_refused <name> <expected-rc> <anchor> <args...>
#
# A refusal is only correct if it ALSO wrote no state — that pairing is the
# property, not the exit code alone.
assert_refused() {
	local name="$1" expect="$2" anchor="$3"
	shift 3
	run "$anchor" "$@"
	if [ "$RUN_RC" -ne "$expect" ]; then
		fail "$name" "expected exit $expect, got $RUN_RC ([$RUN_OUT])"
		return
	fi
	case "$RUN_OUT" in
	*pursue-goal:*) : ;;
	*)
		fail "$name" "exit $expect correct but no 'pursue-goal:' diagnostic: [$RUN_OUT]"
		return
		;;
	esac
	if [ "$(state_files "$anchor")" != "0" ]; then
		fail "$name" "refused but LEFT LOOP STATE BEHIND in $anchor/.goal-gate"
		return
	fi
	pass "$name"
}

# --------------------------------------------------------------------------
# 1. Happy path — the hand-off actually completes
# --------------------------------------------------------------------------

A="$(new_anchor happy)"
G="$(new_goal "$A" X "$OUTSTANDING")"

run "$A" "$G"
assert_equals "happy/exit-zero" "0" "$RUN_RC"
assert_equals "happy/one-state-file" "1" "$(state_files "$A")"

# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
LOOP="$(ls "$A"/.goal-gate/*.state 2>/dev/null | head -1)"
case "$(basename -- "$LOOP")" in
_anon-*.state) pass "happy/written-unclaimed" ;;
*) fail "happy/written-unclaimed" "state file is not an _anon-* workstream: $LOOP" ;;
esac

assert_equals "happy/binds-goal-folder" "$G" "$(bash "$LOOP_STATE" get "$LOOP" goal_folder)"
assert_equals "happy/binds-acs-path" "$G/ACs.md" "$(bash "$LOOP_STATE" get "$LOOP" acs_path)"
assert_equals "happy/status-active" "active" "$(bash "$LOOP_STATE" get "$LOOP" status)"
assert_equals "happy/iteration-zero" "0" "$(bash "$LOOP_STATE" get "$LOOP" iteration)"

case "$RUN_OUT" in
*"loop_state=$LOOP"*) pass "happy/reports-state-path" ;;
*) fail "happy/reports-state-path" "stdout does not name the state file: [$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*[Yy]ield*) pass "happy/instructs-yield" ;;
*) fail "happy/instructs-yield" "no yield instruction in output: [$RUN_OUT]" ;;
esac

# Boundary: exactly one criterion still starts a loop.
A1="$(new_anchor one)"
G1="$(new_goal "$A1" Single "$ONE_ONLY")"
run "$A1" "$G1"
assert_equals "boundary/single-criterion-starts" "0" "$RUN_RC"

# The direct path writes a full contract before it calls the normal starter.
# Validate the direct shape independently so a documentation-only shortcut
# cannot silently lower the evidence bar.
DA="$(new_anchor direct)"
DG="$(new_direct_goal "$DA" DirectLint)"
if bash "$FORMAT_CHECK" "$DG/ACs.md" >/dev/null 2>&1; then
	pass "direct/criteria-are-strictly-valid"
else
	fail "direct/criteria-are-strictly-valid" "the direct contract does not satisfy acs-format-check"
fi
if bash "$CHARTER_CHECK" "$DG" >/dev/null 2>&1; then
	pass "direct/charter-links-the-contract"
else
	fail "direct/charter-links-the-contract" "the direct charter does not satisfy charter-check"
fi
for direct_file in prompt.md DIRECT.md goal.md ACs.md CLAUDE.md AGENTS.md; do
	if [ -s "$DG/$direct_file" ]; then
		pass "direct/emits-$direct_file"
	else
		fail "direct/emits-$direct_file" "the direct bootstrap contract lacks $direct_file"
	fi
done
run "$DA" "$DG"
assert_equals "direct/valid-contract-starts" "0" "$RUN_RC"
if [ "$RUN_RC" -eq 0 ]; then
# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
DIRECT_LOOP="$(ls "$DA"/.goal-gate/*.state 2>/dev/null | head -1)"
	if [ -n "$DIRECT_LOOP" ]; then
		assert_equals "direct/binds-the-direct-folder" "$DG" \
			"$(bash "$LOOP_STATE" get "$DIRECT_LOOP" goal_folder)"
	else
		fail "direct/binds-the-direct-folder" "the successful direct start wrote no loop state"
	fi
else
	fail "direct/binds-the-direct-folder" "the direct starter refusal left no binding to inspect"
fi

# The direct workflow validates its contract before it invokes the starter.
# An invalid direct contract must therefore leave no state at all.
DIA="$(new_anchor direct-invalid)"
DIG="$(new_direct_goal "$DIA" DirectInvalid)"
cat >"$DIG/ACs.md" <<'EOF'
# Done when

- [ ] The invalid direct fixture is repaired in `package.json`.
EOF
if bash "$FORMAT_CHECK" "$DIG/ACs.md" >/dev/null 2>&1; then
	fail "direct/invalid-contract-refuses-before-start" "an incomplete direct contract passed acs-format-check"
else
	pass "direct/invalid-contract-refuses-before-start"
fi
assert_equals "direct/invalid-contract-writes-no-state" "0" "$(state_files "$DIA")"

# A direct contract uses the same one-loop lock. A second direct folder cannot
# start while the first direct loop remains active.
DG2="$(new_direct_goal "$DA" DirectSecond)"
run "$DA" "$DG2"
assert_equals "direct/active-loop-refuses-second-contract" "7" "$RUN_RC"
assert_equals "direct/active-loop-keeps-one-state" "1" "$(state_files "$DA")"

# The direct route does not weaken the registration refusal. It creates no
# state when the active agent cannot prove a registered, runnable gate.
DRA="$(new_anchor direct-unregistered)"
DRG="$(new_direct_goal "$DRA" DirectUnregistered)"
DIRECT_FAKE_HOME="$WORK_DIR/direct-fake-home"
mkdir -p -- "$DIRECT_FAKE_HOME"
DIRECT_REG_OUT="$(GOAL_GATE_SKIP_REGISTRATION_CHECK=0 GOAL_GATE_ANCHOR="$DRA" \
	HOME="$DIRECT_FAKE_HOME" CODEX_HOME="$DIRECT_FAKE_HOME/.codex" \
	bash "$STARTER" "$DRG" 2>&1)"
DIRECT_REG_RC=$?
if [ "$DIRECT_REG_RC" -eq 6 ] && [ "$(state_files "$DRA")" = "0" ]; then
	pass "direct/unregistered-gate-refuses-with-no-state"
else
	fail "direct/unregistered-gate-refuses-with-no-state" "expected exit 6 and no state, got exit $DIRECT_REG_RC: [$DIRECT_REG_OUT]"
fi

# --------------------------------------------------------------------------
# 2. Parameter forms — all name the same workstream
# --------------------------------------------------------------------------

for form in trailing relative goalmd ideadoc; do
	AF="$(new_anchor "form-$form")"
	GF="$(new_goal "$AF" Y "$OUTSTANDING")"
	case "$form" in
	trailing) ARG="$GF/" ;;
	relative) ARG="Y.goal" ;;
	goalmd) ARG="$GF/goal.md" ;;
	ideadoc)
		printf '# idea\n' >"$AF/Y.md"
		ARG="$AF/Y.md"
		;;
	esac
	if [ "$form" = "relative" ]; then
		RUN_OUT="$(cd "$AF" && GOAL_GATE_ANCHOR="$AF" bash "$STARTER" "$ARG" 2>&1)"
		RUN_RC=$?
	else
		run "$AF" "$ARG"
	fi
	if [ "$RUN_RC" -ne 0 ]; then
		fail "form/$form" "expected exit 0, got $RUN_RC ([$RUN_OUT])"
	else
		# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
		LF="$(ls "$AF"/.goal-gate/*.state 2>/dev/null | head -1)"
		assert_equals "form/$form" "$GF" "$(bash "$LOOP_STATE" get "$LF" goal_folder)"
	fi
done

# Security boundary: the parameter is never evaluated as shell.
AS="$(new_anchor shellsafe)"
CANARY="$WORK_DIR/canary-must-not-exist"
assert_refused "security/parameter-not-evaluated" 2 "$AS" "\$(touch $CANARY)"
if [ -e "$CANARY" ]; then
	fail "security/no-side-effect" "the parameter was evaluated as shell — canary exists"
else
	pass "security/no-side-effect"
fi

# --------------------------------------------------------------------------
# 3. Invalid input and empty/null — refuse, and write nothing
# --------------------------------------------------------------------------

AI="$(new_anchor invalid)"
assert_refused "empty/no-parameter" 2 "$AI"
assert_refused "empty/path-does-not-exist" 2 "$AI" "$AI/nope"

mkdir -p -- "$AI/bare"
assert_refused "invalid/not-a-goal-folder" 2 "$AI" "$AI/bare"

mkdir -p -- "$AI/nogoal.goal"
printf -- '- [ ] a\n' >"$AI/nogoal.goal/ACs.md"
assert_refused "invalid/goal-md-missing" 2 "$AI" "$AI/nogoal.goal"

mkdir -p -- "$AI/noacs.goal"
printf '# c\n' >"$AI/noacs.goal/goal.md"
assert_refused "invalid/acs-missing" 2 "$AI" "$AI/noacs.goal"

mkdir -p -- "$AI/emptyacs.goal"
printf '# c\n' >"$AI/emptyacs.goal/goal.md"
: >"$AI/emptyacs.goal/ACs.md"
assert_refused "invalid/acs-empty-fails-closed" 2 "$AI" "$AI/emptyacs.goal"

# A checklist with no criteria is not "all complete".
GN="$(new_goal "$AI" Nocrit '# Done when

Nothing here is a criterion.')"
assert_refused "invalid/zero-criteria-fails-closed" 2 "$AI" "$GN"

# --------------------------------------------------------------------------
# 4. Boundary — an all-checked folder starts no loop
# --------------------------------------------------------------------------

AD="$(new_anchor alldone)"
GD="$(new_goal "$AD" Done "$ALL_DONE")"
run "$AD" "$GD"
assert_equals "boundary/all-checked-exit" "4" "$RUN_RC"
assert_equals "boundary/all-checked-no-state" "0" "$(state_files "$AD")"
case "$RUN_OUT" in
*"nothing to do"*) pass "boundary/all-checked-reports" ;;
*) fail "boundary/all-checked-reports" "no nothing-to-do report: [$RUN_OUT]" ;;
esac

# --------------------------------------------------------------------------
# 5. Error propagation — unreadable input
# --------------------------------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
	pass "error/unreadable-folder-skipped-as-root"
else
	AU="$(new_anchor unreadable)"
	GU="$(new_goal "$AU" Locked "$OUTSTANDING")"
	chmod 000 "$GU/ACs.md"
	assert_refused "error/unreadable-acs-reported" 3 "$AU" "$GU"
	chmod 644 "$GU/ACs.md"
fi

# --------------------------------------------------------------------------
# 6. The registration refusal — the load-bearing one
# --------------------------------------------------------------------------

AR="$(new_anchor unregistered)"
GR="$(new_goal "$AR" Unreg "$OUTSTANDING")"
FAKE_HOME="$WORK_DIR/fake-home"
mkdir -p -- "$FAKE_HOME"
export CODEX_HOME="$FAKE_HOME/.codex"

RUN_OUT="$(GOAL_GATE_SKIP_REGISTRATION_CHECK=0 GOAL_GATE_ANCHOR="$AR" \
	HOME="$FAKE_HOME" CODEX_HOME="$FAKE_HOME/.codex" \
	bash "$STARTER" "$GR" 2>&1)"
RUN_RC=$?
if [ "$RUN_RC" -ne 6 ]; then
	fail "registration/unregistered-refuses" "expected exit 6, got $RUN_RC ([$RUN_OUT])"
elif [ "$(state_files "$AR")" != "0" ]; then
	fail "registration/unregistered-refuses" "refused but wrote loop state"
else
	pass "registration/unregistered-refuses"
fi
case "$RUN_OUT" in
*"not registered"*) pass "registration/refusal-names-the-cause" ;;
*) fail "registration/refusal-names-the-cause" "refusal does not say the gate is unregistered: [$RUN_OUT]" ;;
esac

# Codex skips every hook check. Codex cloud can register the Stop hook but
# offers no way to trust it, so the hook never fires there. A
# Codex run with no registration and no proof must still bind, and must tell
# the agent to continue rather than chase the hook.
ACX="$(new_anchor codex-no-hook)"
GCX="$(new_goal "$ACX" CodexNoHook "$OUTSTANDING")"
CODEX_OUT="$(GOAL_GATE_SKIP_REGISTRATION_CHECK=0 GOAL_GATE_SKIP_PROVISION=1 \
	GOAL_GATE_ANCHOR="$ACX" GOAL_GATE_AGENT=codex HOME="$FAKE_HOME" \
	CODEX_HOME="$FAKE_HOME/.codex" bash "$STARTER" "$GCX" 2>&1)"
CODEX_RC=$?
if [ "$CODEX_RC" -eq 0 ] && [ "$(state_files "$ACX")" = "1" ]; then
	pass "registration/codex-binds-without-hook"
else
	fail "registration/codex-binds-without-hook" \
		"expected Codex to bind with no hook, got exit $CODEX_RC: [$CODEX_OUT]"
fi
case "$CODEX_OUT" in
*"Continue in Codex"*) pass "registration/codex-says-continue" ;;
*) fail "registration/codex-says-continue" "no continue instruction: [$CODEX_OUT]" ;;
esac
case "$CODEX_OUT" in
*"prove codex"* | *"Open /hooks"*) fail "registration/codex-never-asks-for-proof" \
	"Codex output still asks for proof or trust: [$CODEX_OUT]" ;;
*) pass "registration/codex-never-asks-for-proof" ;;
esac

# Expand only a complete supported placeholder. A longer variable name must
# not inherit the `$CLAUDE_PROJECT_DIR` prefix expansion.
# shellcheck disable=SC2016 # The literal variable spelling is the test input.
PREFIX_COMMAND='$CLAUDE_PROJECT_DIRECTORY/.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh'
PREFIX_ENCODED="$(printf '%s' "$PREFIX_COMMAND" | jq -Rs -r '@base64')"
PREFIX_RC=0
(
	# shellcheck source=/dev/null
	source "$STARTER" >/dev/null 2>&1
	pg_direct_command_path "$PREFIX_ENCODED" "$WORK_DIR/prefix-anchor" claude
) >/dev/null 2>&1 || PREFIX_RC=$?
if [ "$PREFIX_RC" -ne 0 ]; then
	pass "registration/placeholder-prefix-is-not-expanded"
else
	fail "registration/placeholder-prefix-is-not-expanded" \
		"a longer variable name was accepted as a project placeholder"
fi

# Claude still accepts its existing project registration after the shared
# resolver refactor. Claude does not require a Codex proof marker.
APC_CLAUDE="$(new_anchor 'project "quoted" checkout')"
GPC_CLAUDE="$(new_goal "$APC_CLAUDE" ProjectClaude "$OUTSTANDING")"
CLAUDE_GATE="$APC_CLAUDE/.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh"
mkdir -p -- "$(dirname -- "$CLAUDE_GATE")" "$APC_CLAUDE/.claude"
cp -- "$GATE" "$CLAUDE_GATE"
chmod +x "$CLAUDE_GATE"
for helper in cancel.sh loop-state.sh parse-acs.sh validate-acs.sh proof-of-fire.sh; do
	cp -- "$TEST_DIR/../$helper" "$(dirname -- "$CLAUDE_GATE")/$helper"
	chmod +x "$(dirname -- "$CLAUDE_GATE")/$helper"
done
python3 "$MERGE_HOOKS" "$APC_CLAUDE/.claude/settings.json" >/dev/null
CLAUDE_OUT="$(GOAL_GATE_SKIP_REGISTRATION_CHECK=0 GOAL_GATE_SKIP_PROVISION=1 \
	GOAL_GATE_ANCHOR="$APC_CLAUDE" GOAL_GATE_AGENT=claude HOME="$FAKE_HOME" \
	CODEX_HOME="$FAKE_HOME/.codex" bash "$STARTER" "$GPC_CLAUDE" 2>&1)"
CLAUDE_RC=$?
if [ "$CLAUDE_RC" -eq 0 ] && [ "$(state_files "$APC_CLAUDE")" = "1" ]; then
	pass "registration/claude-project-hook-still-starts"
else
	fail "registration/claude-project-hook-still-starts" \
		"expected the Claude project hook to start, got exit $CLAUDE_RC: [$CLAUDE_OUT]"
fi

# --------------------------------------------------------------------------
# 7. State transitions and concurrency — one loop at a time
# --------------------------------------------------------------------------

AC="$(new_anchor concurrent)"
GC="$(new_goal "$AC" Once "$OUTSTANDING")"
run "$AC" "$GC"
assert_equals "state/first-start-ok" "0" "$RUN_RC"
assert_refused_second() {
	run "$AC" "$GC"
	if [ "$RUN_RC" -ne 7 ]; then
		fail "state/re-invoke-refused" "expected exit 7, got $RUN_RC ([$RUN_OUT])"
	elif [ "$(state_files "$AC")" != "1" ]; then
		fail "state/re-invoke-refused" "a second loop file was created"
	else
		pass "state/re-invoke-refused"
	fi
}
assert_refused_second

# A DIFFERENT folder in the same tree is also refused — one gate directory
# governs one loop, and the refusal says which workstream holds it.
GC2="$(new_goal "$AC" Other "$OUTSTANDING")"
run "$AC" "$GC2"
assert_equals "state/second-folder-refused" "7" "$RUN_RC"
case "$RUN_OUT" in
*"$GC"*) pass "state/second-folder-names-holder" ;;
*) fail "state/second-folder-names-holder" "refusal does not name the active workstream: [$RUN_OUT]" ;;
esac

# A terminal loop is history, not a competitor: a new run may start.
# shellcheck disable=SC2012  # fixture directory, alphanumeric names only
bash "$LOOP_STATE" set "$(ls "$AC"/.goal-gate/*.state | head -1)" status complete
run "$AC" "$GC"
assert_equals "state/restart-after-terminal" "0" "$RUN_RC"

# True concurrency: two starters racing on the same folder produce exactly one
# loop, and the loser reports rather than silently succeeding.
AP="$(new_anchor parallel)"
GP="$(new_goal "$AP" Race "$OUTSTANDING")"
# Both children's outcomes are CAPTURED. Asserting only the file count left the
# stated property — "the loser reports rather than silently succeeding" —
# untested: a loser that exited 0 in silence passed identically.
(
	GOAL_GATE_ANCHOR="$AP" bash "$STARTER" "$GP" >"$WORK_DIR/race1.out" 2>&1
	printf '%s' "$?" >"$WORK_DIR/race1.rc"
) &
(
	GOAL_GATE_ANCHOR="$AP" bash "$STARTER" "$GP" >"$WORK_DIR/race2.out" 2>&1
	printf '%s' "$?" >"$WORK_DIR/race2.rc"
) &
wait
assert_equals "concurrency/exactly-one-loop" "1" "$(state_files "$AP")"

RC1="$(cat "$WORK_DIR/race1.rc" 2>/dev/null)"
RC2="$(cat "$WORK_DIR/race2.rc" 2>/dev/null)"
WINNERS=0
for rc in "$RC1" "$RC2"; do
	[ "$rc" = "0" ] && WINNERS=$((WINNERS + 1))
done
assert_equals "concurrency/exactly-one-winner" "1" "$WINNERS"

# The loser must have SAID so — exit 7, with a diagnostic.
LOSER_OUT=""
[ "$RC1" != "0" ] && LOSER_OUT="$(cat "$WORK_DIR/race1.out" 2>/dev/null)"
[ "$RC2" != "0" ] && LOSER_OUT="$(cat "$WORK_DIR/race2.out" 2>/dev/null)"
case "$LOSER_OUT" in
*"already active"*) pass "concurrency/loser-reports-rather-than-succeeding" ;;
*) fail "concurrency/loser-reports-rather-than-succeeding" "the losing starter did not report why it stopped: [$LOSER_OUT]" ;;
esac

# Two DIFFERENT folders in different trees are independent.
AT1="$(new_anchor tree1)"
AT2="$(new_anchor tree2)"
GT1="$(new_goal "$AT1" A "$OUTSTANDING")"
GT2="$(new_goal "$AT2" B "$OUTSTANDING")"
run "$AT1" "$GT1"
R1=$RUN_RC
run "$AT2" "$GT2"
assert_equals "concurrency/independent-trees" "00" "$R1$RUN_RC"

# --------------------------------------------------------------------------
# 8. The folder must be inside the tree the gate can see
# --------------------------------------------------------------------------

AO="$(new_anchor outside)"
AX="$(new_anchor elsewhere)"
GX="$(new_goal "$AX" Far "$OUTSTANDING")"
assert_refused "boundary/folder-outside-anchor" 2 "$AO" "$GX"

# --------------------------------------------------------------------------
# 9. The skill document exists and states the load-bearing rules
# --------------------------------------------------------------------------

SKILL="${TEST_DIR}/../../eque2-code-pursue-goal/SKILL.md"
if [ -f "$SKILL" ]; then
	pass "skill/document-present"
	for token in "pursue-goal" "execute goal" "yield" "ACs.md" "evidence"; do
		if grep -qi -- "$token" "$SKILL"; then
			pass "skill/states-$(printf '%s' "$token" | tr ' .' '--')"
		else
			fail "skill/states-$(printf '%s' "$token" | tr ' .' '--')" "SKILL.md does not mention '$token'"
		fi
	done
	if grep -Eqi -- 'only intentional yield|one bootstrap turn' "$SKILL"; then
		pass "skill/limits-yield-to-bootstrap"
	else
		fail "skill/limits-yield-to-bootstrap" "SKILL.md does not limit yielding to the bootstrap hand-off"
	fi
	if grep -Eqi -- 'hard wait|hard-wait|background task' "$SKILL"; then
		pass "skill/keeps-background-waits-in-turn"
	else
		fail "skill/keeps-background-waits-in-turn" "SKILL.md does not require in-turn waiting for background work"
	fi
	for token in 'pursue the goal of' 'DIRECT.md' 'acs-format-check.sh' 'charter-check.sh' 'same-conversation exception' 'git rev-parse --show-toplevel' 'CLAUDE.md' 'AGENTS.md' 'slug collision' 'If another loop is active' 'Do not run the starter against an invalid contract'; do
		if grep -Fqi -- "$token" "$SKILL"; then
			pass "skill/direct-inline-states-$(printf '%s' "$token" | tr ' .-' '---')"
		else
			fail "skill/direct-inline-states-$(printf '%s' "$token" | tr ' .-' '---')" "SKILL.md does not state '$token'"
		fi
	done
else
	fail "skill/document-present" "no skill document at $SKILL"
fi

HANNIBAL="${TEST_DIR}/../../eque2-code-agent-hannibal/SKILL.md"
GATE_SKILL="${TEST_DIR}/../SKILL.md"
if grep -Fqi -- 'pursue the goal of <task>' "$HANNIBAL"; then
	pass "routing/hannibal-names-direct-inline-route"
else
	fail "routing/hannibal-names-direct-inline-route" "Hannibal does not route the explicit direct phrase"
fi
if grep -Fqi -- 'direct inline bootstrap' "$GATE_SKILL"; then
	pass "routing/gate-keeps-direct-bootstrap-outside-the-gate"
else
	fail "routing/gate-keeps-direct-bootstrap-outside-the-gate" "goal-gate does not name the direct bootstrap boundary"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
