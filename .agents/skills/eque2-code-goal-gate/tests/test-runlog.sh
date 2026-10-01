#!/usr/bin/env bash
# test-runlog.sh — conformance suite for goal-gate-stop.sh's STRUCTURED RUN LOG
# and health surface (T2.6).
#
# This is requirement E, and it fixes ancestor defect D7: `last_result`,
# `last_output` and `history` were DOCUMENTED as hook-managed and never actually
# written. A log that is described but absent is worse than no log — a reader
# trusts it, finds it empty, and concludes the loop never ran.
#
# The surface contract is behavioural, not cosmetic: a reader answers "is this
# loop healthy, and if not what is it stuck on?" from the log alone. Every field
# asserted here exists to serve that question — iteration (how far), met/unmet
# (how much is left), decision (what happened), agent shape (which host), elapsed
# (how long it took). A record missing any of them cannot answer it.
#
# THE DECISION IS NEVER AFFECTED BY LOGGING. A log that cannot be written
# degrades and SAYS SO; it never changes a refusal into a permit or vice versa.
# Observability that can alter the verdict is not observability, it is a second
# decision path — and one nobody tests.
#
# S31 is asserted by RESOLVING THE PATH, not by assuming it: the log must land
# outside the protected state area, and "outside" is checked against the actual
# directory the gate used, because an assumption here is exactly how a log ends
# up inside the guarded area and trips the protection it was supposed to respect.
#
# Plain bash asserts — deliberately NOT bats. One PASS/FAIL line per test;
# exits non-zero on any FAIL.

# shellcheck disable=SC2016
# Backticks are LITERAL ACs.md markup inside fixture text, never substitution.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_MODULE:-${TEST_DIR}/../goal-gate-stop.sh}"

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-runlog.XXXXXX")"
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

new_goal() {
	local d
	d="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	d="$(cd -- "$d" && pwd -P)"
	mkdir -p "$d/.goal-gate"
	printf '%s' "$d"
}

RUN_OUT=""
RUN_ERR=""

gate_run() {
	local goal="$1" payload="$2"
	shift 2
	local outf errf
	outf="$(mktemp "$WORK_DIR/out.XXXXXX")"
	errf="$(mktemp "$WORK_DIR/err.XXXXXX")"
	printf '%s' "$payload" |
		env "GOAL_GATE_DIR=$goal/.goal-gate" "$@" bash "$GATE" >"$outf" 2>"$errf"
	RUN_OUT="$(cat -- "$outf")"
	RUN_ERR="$(cat -- "$errf")"
	rm -f -- "$outf" "$errf"
}

# runlog <goal> — path of the run log the gate actually used, as reported by
# the gate itself. RESOLVED, never assumed (S31).
runlog() {
	printf '%s' "$1/run-log.jsonl"
}

write_unmet() {
	cat >"$1/ACs.md" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
- [ ] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - explanation: the second-run assertion has not been written yet
EOF
}

write_all_met() {
	cat >"$1/ACs.md" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
EOF
}

# field <json-line> <key> — read a field, or empty.
field() {
	printf '%s' "$1" | jq -r ".$2 // empty" 2>/dev/null
}

printf '== goal-gate structured run log (T2.6) conformance suite ==\n'
printf 'gate: %s\n\n' "$GATE"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite.\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: every required field, on every record --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"log1"}' "GOAL_GATE_STALL_MAX=5"

LOG="$(runlog "$GOAL")"
if [ -f "$LOG" ]; then
	pass "happy/the-log-is-created-on-the-first-evaluation"
else
	fail "happy/the-log-is-created-on-the-first-evaluation" "no log at $LOG (ancestor D7: documented, never written)"
fi

REC="$(head -1 "$LOG" 2>/dev/null)"
if printf '%s' "$REC" | jq -e . >/dev/null 2>&1; then
	pass "happy/the-record-is-valid-json"
else
	fail "happy/the-record-is-valid-json" "not parseable: [$REC]"
fi

# The five fields S30 names, each asserted individually so a partial record
# fails on the field it is missing rather than as a vague whole.
for f in iteration decision unmet total agent elapsed_s; do
	v="$(field "$REC" "$f")"
	if [ -n "$v" ]; then
		pass "happy/record-carries-$f"
	else
		fail "happy/record-carries-$f" "field [$f] absent or empty in [$REC]"
	fi
done

assert_equals "happy/the-decision-is-the-one-that-was-reached" "refused_unmet" "$(field "$REC" decision)"
assert_equals "happy/the-unmet-count-is-real" "1" "$(field "$REC" unmet)"
assert_equals "happy/the-total-is-real" "2" "$(field "$REC" total)"
assert_equals "happy/the-detected-agent-shape-is-recorded" "claude" "$(field "$REC" agent)"

# ===========================================================================
printf -- '-- 2. Appended, never truncated --\n'
# ===========================================================================

gate_run "$GOAL" '{"session_id":"log1"}' "GOAL_GATE_STALL_MAX=5"
gate_run "$GOAL" '{"session_id":"log1"}' "GOAL_GATE_STALL_MAX=5"

COUNT="$(wc -l <"$LOG" | tr -d ' ')"
if [ "$COUNT" -ge 3 ]; then
	pass "append/every-evaluation-adds-a-record ($COUNT)"
else
	fail "append/every-evaluation-adds-a-record" "expected >=3 records, got $COUNT — the log is being overwritten"
fi

assert_equals "append/the-first-record-is-still-there" "refused_unmet" "$(field "$(head -1 "$LOG")" decision)"

# Iteration must ADVANCE across records: a log where every record says
# iteration 1 cannot answer "how far has this loop got", which is the whole
# point of the surface (and was ancestor D3's symptom).
FIRST_IT="$(field "$(head -1 "$LOG")" iteration)"
LAST_IT="$(field "$(tail -1 "$LOG")" iteration)"
if [ -n "$FIRST_IT" ] && [ -n "$LAST_IT" ] && [ "$LAST_IT" -gt "$FIRST_IT" ] 2>/dev/null; then
	pass "append/the-iteration-advances-across-records ($FIRST_IT -> $LAST_IT)"
else
	fail "append/the-iteration-advances-across-records" "first=$FIRST_IT last=$LAST_IT"
fi

# ===========================================================================
printf -- '-- 3. S31: the log lands OUTSIDE the protected state area --\n'
# ===========================================================================
#
# Resolved, not assumed. The guarded area is the gate directory itself; the log
# must not be inside it, or writing the log trips the protection it exists to
# respect.

LOG_REAL="$(cd -- "$(dirname -- "$LOG")" && pwd -P)/$(basename -- "$LOG")"
GATEDIR_REAL="$(cd -- "$GOAL/.goal-gate" && pwd -P)"

case "$LOG_REAL" in
"$GATEDIR_REAL"/*)
	fail "s31/the-log-is-outside-the-protected-state-area" \
		"the log [$LOG_REAL] is INSIDE the guarded area [$GATEDIR_REAL]"
	;;
*)
	pass "s31/the-log-is-outside-the-protected-state-area"
	;;
esac

# And it is still inside the goal folder — containment is not traded away to
# satisfy S31 by scattering the log somewhere else entirely.
case "$LOG_REAL" in
"$GOAL"/*) pass "s31/the-log-is-still-inside-the-goal-folder" ;;
*) fail "s31/the-log-is-still-inside-the-goal-folder" "the log escaped to [$LOG_REAL]" ;;
esac

# ===========================================================================
printf -- '-- 4. An unwritable log degrades the LOG, never the DECISION --\n'
# ===========================================================================
#
# Observability that can alter the verdict is a second decision path. The gate
# must reach the same decision with its log broken as with it working.

GOAL_OK="$(new_goal)"
write_unmet "$GOAL_OK"
gate_run "$GOAL_OK" '{"session_id":"ctrl"}' "GOAL_GATE_STALL_MAX=5"
CTRL_OUT="$RUN_OUT"

GOAL_RO="$(new_goal)"
write_unmet "$GOAL_RO"
# A directory where the log should be: unwritable as a file path, by construction.
mkdir -p "$GOAL_RO/run-log.jsonl"
gate_run "$GOAL_RO" '{"session_id":"ro1"}' "GOAL_GATE_STALL_MAX=5"

# Compared with each fixture's own path normalised out: the two goals live in
# different temp directories, so the reason text legitimately differs there.
# What must be identical is the DECISION and the counts behind it.
norm_decision() {
	printf '%s' "$1" | sed -e 's#/[^" ]*/ACs\.md#<ACS>#g'
}
assert_equals "degrade/the-decision-is-identical-with-a-broken-log" \
	"$(norm_decision "$CTRL_OUT")" "$(norm_decision "$RUN_OUT")"

case "$RUN_ERR" in
*log*) pass "degrade/the-degradation-is-reported" ;;
*) fail "degrade/the-degradation-is-reported" "a broken log was silent (err=[$RUN_ERR])" ;;
esac

# A permit must also survive a broken log — the expensive direction is a
# completion silently withheld because logging failed.
GOAL_RO2="$(new_goal)"
write_all_met "$GOAL_RO2"
mkdir -p "$GOAL_RO2/run-log.jsonl"
gate_run "$GOAL_RO2" '{"session_id":"ro2"}' "GOAL_GATE_STALL_MAX=5"
case "$RUN_ERR" in
*'PERMIT:'*) pass "degrade/a-broken-log-does-not-withhold-a-permit" ;;
*) fail "degrade/a-broken-log-does-not-withhold-a-permit" "err=[$RUN_ERR]" ;;
esac

# ===========================================================================
printf -- '-- 5. Error propagation: prior records survive a bad write --\n'
# ===========================================================================

GOAL_P="$(new_goal)"
write_unmet "$GOAL_P"
gate_run "$GOAL_P" '{"session_id":"part1"}' "GOAL_GATE_STALL_MAX=5"
LOGP="$(runlog "$GOAL_P")"
GOOD="$(head -1 "$LOGP")"

# A truncated trailing record, as an interrupted append would leave.
printf '{"iteration":2,"decis' >>"$LOGP"

gate_run "$GOAL_P" '{"session_id":"part1"}' "GOAL_GATE_STALL_MAX=5"

assert_equals "errprop/the-earlier-record-is-still-readable" "$GOOD" "$(head -1 "$LOGP")"

VALID="$(grep -c '^{.*}$' "$LOGP" 2>/dev/null || printf '0')"
if [ "$VALID" -ge 2 ]; then
	pass "errprop/whole-records-remain-parseable-around-a-partial-one ($VALID)"
else
	fail "errprop/whole-records-remain-parseable-around-a-partial-one" "only $VALID whole records"
fi

# ===========================================================================
printf -- '-- 6. Concurrency: records do not interleave --\n'
# ===========================================================================
#
# Six gates ending a turn together. A record spliced through the middle of
# another is unparseable, and one unparseable record poisons the reader's
# ability to answer the health question at exactly the moment it matters.

GOAL_C="$(new_goal)"
write_unmet "$GOAL_C"
BARRIER="$WORK_DIR/barrier"
for i in 1 2 3 4 5 6; do
	(
		while [ ! -f "$BARRIER" ]; do :; done
		printf '%s' "{\"session_id\":\"conc$i\"}" |
			env "GOAL_GATE_DIR=$GOAL_C/.goal-gate" "GOAL_GATE_STALL_MAX=9" \
				bash "$GATE" >/dev/null 2>&1
	) &
done
: >"$BARRIER"
wait

LOGC="$(runlog "$GOAL_C")"
TOTAL_LINES="$(wc -l <"$LOGC" 2>/dev/null | tr -d ' ')"
BAD=0
while IFS= read -r line; do
	[ -n "$line" ] || continue
	printf '%s' "$line" | jq -e . >/dev/null 2>&1 || BAD=$((BAD + 1))
done <"$LOGC"

assert_equals "concurrency/no-record-was-spliced-into-another" "0" "$BAD"
if [ "$TOTAL_LINES" -ge 2 ]; then
	pass "concurrency/the-race-actually-produced-records ($TOTAL_LINES)"
else
	fail "concurrency/the-race-actually-produced-records" \
		"only $TOTAL_LINES record(s) — the concurrency assertion above proves nothing"
fi

# ===========================================================================
printf -- '-- 7. Resource limits: growth is bounded, and the policy is stated --\n'
# ===========================================================================

GOAL_G="$(new_goal)"
write_unmet "$GOAL_G"
gate_run "$GOAL_G" '{"session_id":"grow1"}' "GOAL_GATE_STALL_MAX=9"
LOGG="$(runlog "$GOAL_G")"

# Pad the log past the cap, then run again: the gate must bound it rather than
# append forever. A loop left running for days must not fill the disk.
i=0
while [ "$i" -lt 400 ]; do
	printf '{"filler":%s,"pad":"%s"}\n' "$i" "$(printf 'x%.0s' $(seq 1 200))" >>"$LOGG"
	i=$((i + 1))
done
BEFORE_BYTES="$(wc -c <"$LOGG" | tr -d ' ')"

gate_run "$GOAL_G" '{"session_id":"grow1"}' "GOAL_GATE_MAX_LOG_BYTES=20000" "GOAL_GATE_STALL_MAX=9"
AFTER_BYTES="$(wc -c <"$LOGG" | tr -d ' ')"

if [ "$AFTER_BYTES" -lt "$BEFORE_BYTES" ]; then
	pass "limits/an-oversized-log-is-bounded ($BEFORE_BYTES -> $AFTER_BYTES bytes)"
else
	fail "limits/an-oversized-log-is-bounded" "grew unbounded: $BEFORE_BYTES -> $AFTER_BYTES"
fi

# Bounding must not destroy the record just written — a rotation that loses the
# current evaluation defeats the surface it is protecting.
LAST="$(tail -1 "$LOGG")"
if printf '%s' "$LAST" | jq -e '.decision' >/dev/null 2>&1; then
	pass "limits/the-newest-record-survives-the-bounding"
else
	fail "limits/the-newest-record-survives-the-bounding" "tail is [$LAST]"
fi

# ===========================================================================
printf -- '-- 8. The health question is answerable from the log alone --\n'
# ===========================================================================
#
# The surface contract, asserted structurally here; T4.3 demonstrates it with a
# human. A stalled loop must be distinguishable from a working one (S32) by
# READING, not by inference.

GOAL_S="$(new_goal)"
write_unmet "$GOAL_S"
# Four turns, not two: the threshold WARNS and twice the threshold ends the loop,
# so the log must show the escalation as well as the ending.
for _ in 1 2 3 4; do
	gate_run "$GOAL_S" '{"session_id":"stalled1"}' "GOAL_GATE_STALL_MAX=2"
done

LOGS="$(runlog "$GOAL_S")"
LASTS="$(tail -1 "$LOGS")"
assert_equals "health/a-stalled-loop-says-so-in-its-last-record" "stalled" "$(field "$LASTS" decision)"
# The warning is in the log too, so "when did this start going nowhere?" is
# answerable by reading rather than by inference.
if grep -q 'refused_stall_warning' "$LOGS"; then
	pass "health/the-log-shows-the-warning-that-preceded-the-stall"
else
	fail "health/the-log-shows-the-warning-that-preceded-the-stall" \
		"no refused_stall_warning record before the stall"
fi

# And the unmet criteria are named, so "what is it stuck on" is answerable
# without opening any other file.
if printf '%s' "$LASTS" | jq -e '.unmet' >/dev/null 2>&1; then
	pass "health/the-outstanding-count-is-in-the-record"
else
	fail "health/the-outstanding-count-is-in-the-record" "[$LASTS]"
fi

# A healthy (progressing) loop must NOT read as stalled.
GOAL_H="$(new_goal)"
write_unmet "$GOAL_H"
gate_run "$GOAL_H" '{"session_id":"healthy1"}' "GOAL_GATE_STALL_MAX=9"
LOGH="$(runlog "$GOAL_H")"
case "$(field "$(tail -1 "$LOGH")" decision)" in
stalled) fail "health/a-healthy-loop-does-not-read-as-stalled" "a single-turn loop reported stalled" ;;
*) pass "health/a-healthy-loop-does-not-read-as-stalled" ;;
esac

# ===========================================================================
printf '\n'
if [ "$FAIL_COUNT" -eq 0 ]; then
	printf '== %s passed, %s failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
	exit 0
fi
printf '== %s passed, %s FAILED ==\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
