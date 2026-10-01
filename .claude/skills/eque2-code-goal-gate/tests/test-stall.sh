#!/usr/bin/env bash
# test-stall.sh — executable conformance suite for goal-gate-stop.sh's
# STALL DETECTION (T2.4).
#
# The property under test: a loop that is repeating WITHOUT PROGRESS must be
# brought to a REPORTED END, and a loop that is making progress must never be
# accused of stalling.
#
# Two ancestor defects are what this suite keeps dead:
#
#   D3 — the ancestor compared TOTAL iterations rather than CONSECUTIVE
#        identical states, and carried `STALL_COUNT`/`CONSECUTIVE` variables
#        that were assigned and never read. Its stall detection did not run.
#        So "progress resets the counter" is asserted here directly: a loop
#        that ticks one more criterion each turn must survive well past the
#        threshold.
#
#   D8 — the ancestor let an ABSENT HASHING TOOL yield an empty hash, which
#        then compared equal to the previous empty hash, so a machine with no
#        shasum declared a spurious stall on iteration 2 and killed healthy
#        loops. Here an unavailable hashing tool is an ERROR that REFUSES —
#        it never produces a hash, and never terminates a loop.
#
# The direction of each failure matters and is asserted separately:
#   - a MISSED stall leaves the session blocked forever (R6);
#   - a SPURIOUS stall ends a healthy loop early and reports work undone.
# A gate that always stalls and a gate that never stalls must BOTH fail this
# suite. Section 7's mutation check enforces exactly that.
#
# A stall is a NON-COMPLETION. Reaching the threshold never marks a criterion
# met, never writes a completion record, and never permits the turn to end
# silently-as-success — it emits a terminal decision naming the stall and the
# outstanding criteria. That distinction is asserted on every terminal path.
#
# Observables only. Nothing here inspects the gate's internals; every assertion
# reads stdout, stderr, the exit status, or the loop-state file through
# loop-state.sh, its own public reader.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# GATE override (for the non-vacuity mutation check only):
#   GOAL_GATE_MODULE=/path/to/mutant.sh bash test-stall.sh

# shellcheck disable=SC2016
# Backticks throughout this file are LITERAL ACs.md markup inside fixture text,
# never command substitution. Single-quoted heredocs are deliberate.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_MODULE:-${TEST_DIR}/../goal-gate-stop.sh}"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-stall.XXXXXX")"
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

# ==========================================================================
# Harness
# ==========================================================================

# new_goal — a fresh `X.goal/` with its `.goal-gate/` inside. Physical path:
# the gate resolves its gate directory with `pwd -P`, and under a $TMPDIR that
# is itself a symlink (every macOS run) a logical path would compare unequal.
new_goal() {
	local d
	d="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	d="$(cd -- "$d" && pwd -P)"
	mkdir -p "$d/.goal-gate"
	printf '%s' "$d"
}

acs() {
	cat >"$1/ACs.md"
}

RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0

# gate_run <goal-folder> <payload> [env assignments...]
gate_run() {
	local goal="$1" payload="$2"
	shift 2
	local outf errf
	outf="$(mktemp "$WORK_DIR/out.XXXXXX")"
	errf="$(mktemp "$WORK_DIR/err.XXXXXX")"

	printf '%s' "$payload" |
		env "GOAL_GATE_DIR=$goal/.goal-gate" "$@" bash "$GATE" >"$outf" 2>"$errf"
	RUN_STATUS=$?
	RUN_OUT="$(cat -- "$outf")"
	RUN_ERR="$(cat -- "$errf")"
	rm -f -- "$outf" "$errf"
}

assert_refuses() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0 (hook contract), got $RUN_STATUS (err=[$RUN_ERR])"
		return 1
	fi
	case "$RUN_OUT" in
	*'"decision":"block"'*) : ;;
	*)
		fail "$name" "expected a block decision on stdout, got [$RUN_OUT]"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

# assert_terminal_stall <name> — the loop ENDED, reported, without a claim.
#
# "THE TURN WAS ALLOWED TO END" IS THE ABSENCE OF A `decision`, NOT THE ABSENCE
# OF BYTES. Only a `decision` key can hold a turn. The gate also emits a
# `systemMessage` object on the paths that END a loop, because `decision`/
# `reason` are delivered to the MODEL and never displayed to the operator — so
# every silent ending was also an invisible one, and a loop that stopped for a
# stated reason stopped without anybody being told the reason. A systemMessage
# cannot block, so asserting on `decision` pins the property that matters and
# stops pinning the one that does not.
#
# The terminal non-completion diagnostic is still required: a permit does not
# block either, so the two must be told apart by what was reported.
assert_terminal_stall() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0, got $RUN_STATUS (err=[$RUN_ERR])"
		return 1
	fi
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "a stall must STOP blocking — got a decision on stdout: [$RUN_OUT]"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'NON-COMPLETION'*) : ;;
	*)
		fail "$name" "did not report a terminal non-completion (err=[$RUN_ERR])"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'PERMIT:'*)
		fail "$name" "announced a PERMIT on a stall path (err=[$RUN_ERR])"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

assert_permits() {
	local name="$1"
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "a permit must not block — got a decision on stdout: [$RUN_OUT]"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'PERMIT:'*) pass "$name" ;;
	*)
		fail "$name" "no PERMIT announced (err=[$RUN_ERR])"
		return 1
		;;
	esac
	return 0
}

assert_err_mentions() {
	local name="$1" needle="$2"
	case "$RUN_ERR" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "stderr did not mention [$needle]: [$RUN_ERR]" ;;
	esac
}

assert_out_mentions() {
	local name="$1" needle="$2"
	case "$RUN_OUT" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "reason did not mention [$needle]: [$RUN_OUT]" ;;
	esac
}

# loop_file <goal-folder> — path of the single .state file, or a marker.
#
# The "exactly one" guard is what makes this order-independent, and it matters
# more now than it did: a gate directory can hold a live loop beside a retired
# one, and `find` enumerates in no order this suite controls. A bare
# `find … | head -1` would silently read a field off whichever file the
# filesystem offered first. The marker string makes a multi-file directory an
# obvious failure instead of a wrong value.
loop_file() {
	local n f
	n="$(find "$1/.goal-gate" -maxdepth 1 -name '*.state' | wc -l | tr -d ' ')"
	if [ "$n" != "1" ]; then
		printf '<%s state files>' "$n"
		return
	fi
	f="$(find "$1/.goal-gate" -maxdepth 1 -name '*.state' | head -1)"
	printf '%s' "$f"
}

state_field() {
	bash "$LOOP_STATE" get "$(loop_file "$1")" "$2" 2>/dev/null || printf ''
}

assert_no_record() {
	if [ -e "$2/.goal-gate/completion-record.md" ]; then
		fail "$1" "a completion record was written on a stall path"
	else
		pass "$1"
	fi
}

# --- fixtures --------------------------------------------------------------

# State A — one criterion outstanding, and it carries an explanation.
write_state_a() {
	acs "$1" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
- [ ] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - explanation: the second-run assertion has not been written yet
EOF
}

# State B — a DIFFERENT outstanding set, so it hashes differently from A.
write_state_b() {
	acs "$1" <<'EOF'
# Acceptance criteria

- [ ] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - explanation: the fixture has not been written yet
- [x] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - evidence: `bash tests/test-install.sh` reported 40/40 PASS (exit 0)
EOF
}

write_all_met() {
	acs "$1" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
- [x] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - evidence: `bash tests/test-install.sh` reported 40/40 PASS (exit 0)
EOF
}

# A progressing loop: criterion N becomes ticked-and-evidenced on turn N, so
# every turn presents a genuinely different outstanding set.
write_progress() {
	local goal="$1" done_count="$2" i
	{
		printf '# Acceptance criteria\n\n'
		for i in 1 2 3 4 5 6 7 8; do
			if [ "$i" -le "$done_count" ]; then
				printf -- '- [x] Criterion %s holds — `.claude/skills/goal-gate/parse-acs.sh`\n' "$i"
				printf -- '      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)\n'
			else
				printf -- '- [ ] Criterion %s holds — `.claude/skills/goal-gate/parse-acs.sh`\n' "$i"
				printf -- '      - explanation: not yet implemented\n'
			fi
		done
	} >"$goal/ACs.md"
}

printf '== goal-gate stall detection (T2.4) conformance suite ==\n'
printf 'gate: %s\n\n' "$GATE"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite (the gate refuses without it).\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: the threshold WARNS, and twice the threshold ends it --\n'
# ===========================================================================
#
# THE THRESHOLD IS NOT THE EXECUTION, and that is a deliberate change from the
# behaviour this suite used to pin. Killing a loop the first time it is seen
# repeating gives the agent no turn in which to act on the diagnosis, and a loop
# killed early costs the whole run where a loop given N more turns costs N turns.
# So the threshold escalates the REFUSAL — naming the repetition to the model and
# to the operator — and the loop ends at twice the threshold.

GOAL="$(new_goal)"
write_state_a "$GOAL"

# Threshold 3: turns 1 and 2 block ordinarily, turn 3 warns, turn 6 is terminal.
gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "happy/turn-1-still-blocks"
assert_equals "happy/turn-1-counts-one" "1" "$(state_field "$GOAL" stall_count)"

gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "happy/turn-2-still-blocks-immediately-before-the-threshold"
assert_equals "happy/turn-2-counts-two" "2" "$(state_field "$GOAL" stall_count)"

gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "happy/turn-3-warns-rather-than-killing-the-loop"
assert_equals "happy/the-warning-is-recorded" \
	"refused_stall_warning" "$(state_field "$GOAL" decision)"
assert_equals "happy/the-warning-is-stamped-once" \
	"1" "$(printf '%s' "$(state_field "$GOAL" stall_warned_at)" | grep -c 'Z$')"
# The warning must reach BOTH audiences: the model, which is the only party that
# can change approach, and the operator, who is the only party that can decide
# to let it end.
case "$RUN_OUT" in
*'not advancing'*) pass "happy/the-warning-tells-the-model-it-is-repeating" ;;
*) fail "happy/the-warning-tells-the-model-it-is-repeating" "[$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*systemMessage*'no measurable progress'*) pass "happy/the-warning-tells-the-operator" ;;
*) fail "happy/the-warning-tells-the-operator" "[$RUN_OUT]" ;;
esac
case "$RUN_OUT" in
*'do not yield or send a status-only response'*) pass "happy/the-warning-tells-the-agent-to-keep-the-turn-open" ;;
*) fail "happy/the-warning-tells-the-agent-to-keep-the-turn-open" "[$RUN_OUT]" ;;
esac

# Turns 4 and 5 keep warning — the nudge is the model's only prompt to change
# course, so it is not delivered once and then withheld.
gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "happy/turn-4-past-the-threshold-still-warns"
gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "happy/turn-5-still-warns"

gate_run "$GOAL" '{"session_id":"stall1"}' "GOAL_GATE_STALL_MAX=3"
assert_terminal_stall "happy/turn-6-twice-the-threshold-declares-the-stall"
assert_equals "happy/state-records-the-stall" "stalled" "$(state_field "$GOAL" decision)"
assert_equals "happy/the-stall-retires-the-workstream" \
	"stalled" "$(state_field "$GOAL" status)"
assert_no_record "happy/a-stall-writes-no-completion-record" "$GOAL"

# The report must be actionable: name the stall, the iteration, and what is
# outstanding. A stall that only says "stalled" is the R6 defect with extra
# words — the reader cannot tell what to do next.
assert_err_mentions "happy/report-names-the-stall" "stall"
assert_err_mentions "happy/report-names-the-outstanding-count" "1 of 2"
assert_err_mentions "happy/report-names-the-unmet-criterion" "The installer is idempotent"
assert_err_mentions "happy/report-states-work-is-not-done" "not"

# A stall is a non-completion, so nothing may be marked met by reaching it.
case "$(state_field "$GOAL" acs_verdict)" in
done) fail "happy/stall-does-not-mark-the-work-done" "acs_verdict=done on a stall" ;;
*) pass "happy/stall-does-not-mark-the-work-done" ;;
esac

# ===========================================================================
printf -- '-- 2. Progress resets the consecutive counter (ancestor D3) --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_progress "$GOAL" 1
gate_run "$GOAL" '{"session_id":"prog1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "progress/turn-1-blocks"

write_progress "$GOAL" 2
gate_run "$GOAL" '{"session_id":"prog1"}' "GOAL_GATE_STALL_MAX=3"
assert_equals "progress/a-changed-state-resets-the-counter" "1" "$(state_field "$GOAL" stall_count)"

write_progress "$GOAL" 3
gate_run "$GOAL" '{"session_id":"prog1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "progress/turn-3-still-blocks-despite-passing-the-threshold-count"
assert_equals "progress/still-counting-one" "1" "$(state_field "$GOAL" stall_count)"

write_progress "$GOAL" 4
gate_run "$GOAL" '{"session_id":"prog1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "progress/a-progressing-loop-is-never-declared-stalled"

case "$(state_field "$GOAL" decision)" in
stalled) fail "progress/no-spurious-stall-recorded" "a progressing loop was recorded as stalled" ;;
*) pass "progress/no-spurious-stall-recorded" ;;
esac

# Then it stops progressing — and the counter must start from that point,
# not resume some historical total (the D3 total-iteration comparison).
gate_run "$GOAL" '{"session_id":"prog1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "progress/first-repeat-after-progress-blocks"
assert_equals "progress/counter-restarts-at-two-not-at-the-total" "2" "$(state_field "$GOAL" stall_count)"

# ===========================================================================
printf -- '-- 3. Flapping A,B,A,B — the documented rule, not an accident --\n'
# ===========================================================================
#
# A loop oscillating between two states makes no progress, so it must not be
# immortal merely because no two ADJACENT turns are identical. The consecutive
# rule alone cannot see it; the bounded-window rule can. The window is 2x the
# threshold, so a flap costs twice a plain stall before it is called.

GOAL="$(new_goal)"
for i in 1 2 3; do
	write_state_a "$GOAL"
	gate_run "$GOAL" '{"session_id":"flap1"}' "GOAL_GATE_STALL_MAX=3"
	if [ "$i" -lt 3 ]; then
		assert_refuses "flap/turn-a$i-blocks"
	fi
	write_state_b "$GOAL"
	gate_run "$GOAL" '{"session_id":"flap1"}' "GOAL_GATE_STALL_MAX=3"
done

assert_terminal_stall "flap/an-oscillating-loop-is-eventually-declared-stalled"
assert_err_mentions "flap/the-report-names-oscillation" "without progress"
assert_no_record "flap/a-flap-stall-writes-no-completion-record" "$GOAL"

# The window rule must not fire on a loop with genuine variety: 6 distinct
# states inside the same window must survive.
GOAL="$(new_goal)"
for i in 1 2 3 4 5 6; do
	write_progress "$GOAL" "$i"
	gate_run "$GOAL" '{"session_id":"variety1"}' "GOAL_GATE_STALL_MAX=3"
done
assert_refuses "flap/a-varied-loop-is-not-caught-by-the-window-rule"

# ===========================================================================
printf -- '-- 4. Boundaries: threshold of 1, and the turn before the threshold --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"thr1"}' "GOAL_GATE_STALL_MAX=1"
assert_refuses "boundary/threshold-of-1-warns-on-the-first-repeat-observation"
gate_run "$GOAL" '{"session_id":"thr1"}' "GOAL_GATE_STALL_MAX=1"
assert_terminal_stall "boundary/threshold-of-1-is-terminal-on-the-second"

# Threshold 2: turns 1 blocks ordinarily, 2 and 3 warn, 4 is terminal. The
# off-by-one is asserted from both sides so neither direction can drift.
GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"thr2"}' "GOAL_GATE_STALL_MAX=2"
assert_refuses "boundary/threshold-2-turn-1-blocks"
gate_run "$GOAL" '{"session_id":"thr2"}' "GOAL_GATE_STALL_MAX=2"
assert_refuses "boundary/threshold-2-turn-2-warns"
gate_run "$GOAL" '{"session_id":"thr2"}' "GOAL_GATE_STALL_MAX=2"
assert_refuses "boundary/threshold-2-turn-3-is-still-not-terminal"
gate_run "$GOAL" '{"session_id":"thr2"}' "GOAL_GATE_STALL_MAX=2"
assert_terminal_stall "boundary/threshold-2-turn-4-is-terminal"

# A met checklist PERMITS even under the tightest threshold. Stall accounting
# must never intercept the completion path.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"met1"}' "GOAL_GATE_STALL_MAX=1"
assert_permits "boundary/a-met-checklist-permits-even-at-threshold-1"

# An invalid threshold falls back to the documented default rather than
# coercing garbage into a plausible number (the ancestor mangled bad input).
GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"badthr"}' "GOAL_GATE_STALL_MAX=not-a-number"
assert_refuses "boundary/a-garbage-threshold-does-not-stall-immediately"
gate_run "$GOAL" '{"session_id":"badthr"}' "GOAL_GATE_STALL_MAX=-4"
assert_refuses "boundary/a-negative-threshold-does-not-stall-immediately"
gate_run "$GOAL" '{"session_id":"badthr"}' "GOAL_GATE_STALL_MAX=0"
assert_refuses "boundary/a-zero-threshold-does-not-stall-immediately"

# ===========================================================================
printf -- '-- 5. Empty/Null: no previous hash, and an empty stored hash --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"empty1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "empty/first-turn-has-no-previous-hash-and-does-not-stall"

HASH1="$(state_field "$GOAL" stall_hash)"
if [ -n "$HASH1" ]; then
	pass "empty/a-hash-is-actually-recorded"
else
	fail "empty/a-hash-is-actually-recorded" "stall_hash is empty after a completed evaluation"
fi

# An EMPTY stored hash must never compare equal to a computed one. This is
# ancestor D8 approached from the state file rather than from the tool: if
# empty-matches-empty were reachable, a corrupted or truncated state file would
# manufacture a stall out of nothing.
bash "$LOOP_STATE" set "$(loop_file "$GOAL")" stall_hash "" >/dev/null 2>&1
bash "$LOOP_STATE" set "$(loop_file "$GOAL")" stall_count "2" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"empty1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "empty/an-empty-stored-hash-does-not-match-a-computed-one"
assert_equals "empty/an-empty-stored-hash-restarts-the-count" "1" "$(state_field "$GOAL" stall_count)"

# A non-numeric stored count is repaired, not arithmetic-errored into a stall.
bash "$LOOP_STATE" set "$(loop_file "$GOAL")" stall_count "garbage" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"empty1"}' "GOAL_GATE_STALL_MAX=3"
assert_refuses "empty/a-corrupt-stored-count-does-not-stall"

# ===========================================================================
printf -- '-- 6. Error propagation: an unavailable hashing tool (ancestor D8) --\n'
# ===========================================================================
#
# The ancestor produced an EMPTY hash when shasum was absent, and empty matched
# empty, so a machine without the tool declared a stall on turn 2 and killed
# healthy loops. Here the absence is an ERROR: the gate REFUSES (keeps
# blocking — fail closed) and never terminates a loop it could not measure.

GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"nohash"}' "GOAL_GATE_STALL_MAX=3" \
	"GOAL_GATE_HASH_TOOL=$WORK_DIR/definitely-not-a-tool"
assert_refuses "errprop/an-unavailable-hashing-tool-refuses"
assert_out_mentions "errprop/the-refusal-names-the-missing-tool" "hash"

# Twice, with the same broken tool: the second turn must ALSO refuse. If an
# unavailable tool yielded an empty hash, this is the turn that would stall.
gate_run "$GOAL" '{"session_id":"nohash"}' "GOAL_GATE_STALL_MAX=1" \
	"GOAL_GATE_HASH_TOOL=$WORK_DIR/definitely-not-a-tool"
assert_refuses "errprop/a-second-unhashable-turn-still-refuses-and-never-stalls"

case "$(state_field "$GOAL" decision)" in
stalled) fail "errprop/no-stall-is-recorded-without-a-hash" "a stall was declared with no hash" ;;
*) pass "errprop/no-stall-is-recorded-without-a-hash" ;;
esac

# A tool that exists but produces nothing is the same class of failure.
EMPTY_TOOL="$WORK_DIR/empty-hash.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$EMPTY_TOOL"
chmod +x "$EMPTY_TOOL"
GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"emptyhash"}' "GOAL_GATE_STALL_MAX=1" "GOAL_GATE_HASH_TOOL=$EMPTY_TOOL"
assert_refuses "errprop/a-silent-hashing-tool-refuses-rather-than-hashing-to-nothing"

# ===========================================================================
printf -- '-- 7. R12 rule 3: unmet WITHOUT an explanation is reported separately --\n'
# ===========================================================================
#
# "1 of 2 outstanding" is not actionable. A criterion nobody has explained is a
# different problem from one that carries a written reason, and the terminal
# report must not blur them — that blurring is what let a model report a
# feature complete while a criterion sat silently unaddressed.

GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"r12a"}' "GOAL_GATE_STALL_MAX=1"
gate_run "$GOAL" '{"session_id":"r12a"}' "GOAL_GATE_STALL_MAX=1"
assert_terminal_stall "r12/an-explained-unmet-criterion-stalls"
assert_err_mentions "r12/the-report-counts-those-carrying-an-explanation" "explanation"
assert_equals "r12/state-records-unmet-with-explanation" "1" "$(state_field "$GOAL" acs_unticked_with_explanation)"
assert_equals "r12/state-records-none-lacking-an-explanation" "0" "$(state_field "$GOAL" acs_unticked_without_explanation)"

# ===========================================================================
printf -- '-- 8. Precedence: LOOP_BLOCKED outranks a stall --\n'
# ===========================================================================
#
# Both are terminal non-completions, so the risk is not a wrong outcome but a
# wrong REPORT: a declared blocker names a cause the loop's own repetition
# cannot, and losing it to a generic stall message costs the reader the reason.

GOAL="$(new_goal)"
write_state_a "$GOAL"
# The signal is KEYED to its workstream — a bare `LOOP_BLOCKED` binds nobody.
printf 'the upstream API credential expired\n' >"$GOAL/.goal-gate/prec1.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"prec1"}' "GOAL_GATE_STALL_MAX=1"
assert_terminal_stall "precedence/a-blocked-loop-ends-terminally"
assert_err_mentions "precedence/the-blocker-reason-survives" "credential expired"
assert_equals "precedence/the-blocker-is-what-is-recorded" "loop_blocked" "$(state_field "$GOAL" decision)"
assert_no_record "precedence/a-blocked-loop-writes-no-completion-record" "$GOAL"

# The stall message must point at the KEYED path, not a bare one. An agent told
# to write `<gate>/LOOP_BLOCKED` would create exactly the unattributable file
# the gate now declines to honour — the advice would not work.
GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"prec2"}' "GOAL_GATE_STALL_MAX=1"
assert_err_mentions "precedence/the-stall-advice-names-the-keyed-signal" "prec2.LOOP_BLOCKED"

# T3.2: the ORDINARY refusal, reached before any stall accounting, already
# carries the blocking instruction. The stall message keeps its own guidance and
# does not simply repeat it.
GOAL="$(new_goal)"
write_state_a "$GOAL"
gate_run "$GOAL" '{"session_id":"instr1"}'
assert_err_mentions "precedence/ordinary-refusal-carries-the-blocking-instruction" "mark it blocked"
assert_err_mentions "precedence/ordinary-refusal-states-the-cost" "does NOT pass"

# ===========================================================================
printf -- '-- 8a. Retirement refuses an EMPTY gate directory --\n'
# ===========================================================================
#
# `gg_stall_terminal` is reached through several frames and cannot be handed
# gg_main's local, so it retires the workstream through the GG_GATE_DIR GLOBAL.
# That global is the empty string until gg_main sets it — which it does not when
# this file is merely sourced — and `gg_retire_workstream` used to compose its
# paths from whatever it was given. An empty gate directory therefore yielded
# `/<base>.state`: a probe of the FILESYSTEM ROOT, for a workstream nobody named.
#
# The guard makes that an immediate refusal. Asserted by BOTH halves, because
# the return code alone was already non-zero for the wrong reason — the missing
# birth token at `/<base>.state` — so a passing exit status proves nothing on its
# own. The absence of the birth-token diagnostic is what proves the function
# stopped BEFORE composing a path.
RETIRE_ERR="$(
	# shellcheck disable=SC1090  # the gate's path is a runtime variable here.
	. "$GATE" >/dev/null 2>&1 || printf 'SOURCE-FAILED\n'
	# shellcheck disable=SC2034  # read by gg_retire_workstream, sourced above.
	GG_WORKSTREAM="_ws-some-owner"
	gg_retire_workstream "" "some-owner" 2>&1 >/dev/null
	printf 'RC=%s' "$?"
)"
case "$RETIRE_ERR" in
*SOURCE-FAILED*)
	fail "empty-gate-dir/the-gate-can-be-sourced-without-running" \
		"sourcing the gate failed, so nothing below was measured: [$RETIRE_ERR]"
	;;
*) pass "empty-gate-dir/the-gate-can-be-sourced-without-running" ;;
esac
case "$RETIRE_ERR" in
*'RC=0') fail "empty-gate-dir/retirement-refuses-an-empty-gate-directory" "it returned 0: [$RETIRE_ERR]" ;;
*) pass "empty-gate-dir/retirement-refuses-an-empty-gate-directory" ;;
esac
case "$RETIRE_ERR" in
*'carries no birth token'*)
	fail "empty-gate-dir/retirement-composes-no-path-from-an-empty-gate-directory" \
		"it reached the birth-token read, so it had already composed a path: [$RETIRE_ERR]"
	;;
*) pass "empty-gate-dir/retirement-composes-no-path-from-an-empty-gate-directory" ;;
esac

# ===========================================================================
printf -- '-- 9. Non-vacuity: a gate that never stalls FAILS this suite --\n'
# ===========================================================================
#
# Every assertion above could be satisfied by a gate that simply refuses
# forever — which is the R6 defect, and the whole reason T2.4 exists. So the
# stall path is proven reachable by MUTATION: a copy of the gate with its
# terminal stall neutered must fail, and the suite reports it if it does not.

MUTANT="$WORK_DIR/mutant-never-stalls.sh"
# `[[:space:]]` not `\s` — BSD sed (every macOS run) does not know `\s`, and a
# pattern that silently matches nothing would turn this check into a no-op.
# Requiring at least one leading blank targets the CALL and never the
# column-0 function definition, which must survive for the mutant to parse.
sed 's/^\([[:space:]][[:space:]]*\)gg_stall_terminal/\1: gg_stall_terminal_disabled/' "$GATE" >"$MUTANT"

if cmp -s "$GATE" "$MUTANT"; then
	fail "mutation/the-mutant-differs-from-the-gate" \
		"the mutation matched nothing — gg_stall_terminal is not called as expected, so this check proves nothing"
else
	pass "mutation/the-mutant-differs-from-the-gate"

	GOAL="$(new_goal)"
	write_state_a "$GOAL"
	MUT_OUT=""
	for i in 1 2 3 4; do
		printf '%s' '{"session_id":"mut1"}' |
			env "GOAL_GATE_DIR=$GOAL/.goal-gate" "GOAL_GATE_STALL_MAX=2" \
				bash "$MUTANT" >"$WORK_DIR/mut.out" 2>/dev/null
		MUT_OUT="$(cat "$WORK_DIR/mut.out")"
	done

	# The mutant must still be BLOCKING after four identical turns — proof the
	# real gate's terminal decision is what ends the loop, not something else.
	case "$MUT_OUT" in
	*'"decision":"block"'*)
		pass "mutation/a-gate-that-never-stalls-blocks-forever"
		;;
	*)
		fail "mutation/a-gate-that-never-stalls-blocks-forever" \
			"the mutant stopped blocking anyway — the stall assertions above are not proving the stall path [$MUT_OUT]"
		;;
	esac
fi

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
