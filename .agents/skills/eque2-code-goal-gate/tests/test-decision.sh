#!/usr/bin/env bash
# test-decision.sh — executable conformance suite for goal-gate-stop.sh's
# COMPLETION DECISION (T2.2): the stage that evaluates ACs.md and emits the
# verdict.
#
# The property under test is FAIL CLOSED. Every unknown, error, timeout or
# missing input must resolve to NOT DONE. The ancestor's decisive defect is the
# one this suite exists to keep dead: its checks ran via `claude -p 2>/dev/null`
# and on error, timeout or absence the EMPTY RESULT WAS TREATED AS A PASS, so it
# reported completion it had never verified (defect D1).
#
# The suite is written so that a gate which merely REFUSES EVERYTHING cannot
# pass it. Section 1 is the permit path, asserted positively: with every
# criterion ticked AND evidenced the turn must be allowed to end and a
# completion record naming the criteria and their evidence must exist. A gate
# that refuses unconditionally fails those assertions — that is checked by
# mutation, not merely hoped for.
#
# Observables only. Nothing here inspects the gate's internals; every assertion
# reads stdout, stderr, the exit status, the loop-state file (through
# loop-state.sh, its own public reader) or the completion record.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.
#
# GATE override (for the non-vacuity mutation check only):
#   GOAL_GATE_MODULE=/path/to/mutant.sh bash test-decision.sh

# shellcheck disable=SC2016
# Backticks throughout this file are LITERAL ACs.md markup inside fixture text
# (a criterion names its specified system in backticks, and evidence quotes the
# commands it ran the same way), never command substitution. Single-quoted
# heredocs are therefore correct and deliberate — expanding them would test the
# harness instead of the gate.

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-decision.XXXXXX")"

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

# new_goal — creates a fresh `X.goal/` folder with its `.goal-gate/` inside,
# and echoes the goal-folder path. Uniqueness comes from mktemp, never from a
# counter: a counter incremented inside a command substitution is discarded
# with the subshell, which silently collapsed every fixture onto one directory
# in an earlier suite.
new_goal() {
	local d
	d="$(mktemp -d "$WORK_DIR/goal.XXXXXX")"
	# Physical path. The gate resolves its gate directory with `pwd -P`, so
	# under a $TMPDIR that is itself a symlink (every macOS run) a logical path
	# here would compare unequal to the one the gate records, and the mismatch
	# would look like a gate defect rather than a harness artefact.
	d="$(cd -- "$d" && pwd -P)"
	mkdir -p "$d/.goal-gate"
	printf '%s' "$d"
}

# acs <goal-folder> — writes stdin as that folder's ACs.md.
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

# assert_refuses <name> — a refusal is exit 0, a block decision on stdout, and
# a diagnostic on stderr. All three, every time.
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
	case "$RUN_ERR" in
	*goal-gate:*) : ;;
	*)
		fail "$name" "refused silently (no goal-gate: diagnostic)"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

# assert_permits <name> — the turn may end AND completion was claimed.
#
# "THE TURN MAY END" IS THE ABSENCE OF A `decision`, NOT THE ABSENCE OF BYTES.
# Only a `decision` key can hold a turn. The gate additionally emits a
# `systemMessage` object on the paths that end a loop — including this one —
# because `decision`/`reason` reach the MODEL and are never displayed to the
# operator, so every ending was invisible to the person running it. A
# systemMessage cannot block, so the assertion is on `decision`.
#
# The PERMIT diagnostic is still required: other outcomes also decline to block,
# so what was REPORTED is what tells them apart.
assert_permits() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0, got $RUN_STATUS (err=[$RUN_ERR])"
		return 1
	fi
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "the turn must be allowed to end — got a decision on stdout: [$RUN_OUT]"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'PERMIT:'*) : ;;
	*)
		fail "$name" "the turn was allowed to end but no PERMIT was announced (err=[$RUN_ERR])"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

# assert_terminal_non_completion <name> — the loop ended WITHOUT a claim.
assert_terminal_non_completion() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0, got $RUN_STATUS (err=[$RUN_ERR])"
		return 1
	fi
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "expected no decision on stdout, got [$RUN_OUT]"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'NON-COMPLETION'*) : ;;
	*)
		fail "$name" "did not report a non-completion (err=[$RUN_ERR])"
		return 1
		;;
	esac
	case "$RUN_ERR" in
	*'PERMIT:'*)
		fail "$name" "announced a PERMIT on a non-completion path (err=[$RUN_ERR])"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

# assert_reason_mentions <name> <needle>
assert_reason_mentions() {
	local name="$1" needle="$2"
	case "$RUN_OUT" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "reason did not mention [$needle]: [$RUN_OUT]" ;;
	esac
}

# assert_reason_lacks <name> <needle>
assert_reason_lacks() {
	local name="$1" needle="$2"
	case "$RUN_OUT" in
	*"$needle"*) fail "$name" "reason unexpectedly contained [$needle]: [$RUN_OUT]" ;;
	*) pass "$name" ;;
	esac
}

# assert_valid_json_block <name> — the refusal must be parseable JSON carrying
# the exact contract keys, or neither agent will act on it.
assert_valid_json_block() {
	local name="$1" decision reason
	decision="$(printf '%s' "$RUN_OUT" | jq -r '.decision' 2>/dev/null)" || {
		fail "$name" "stdout is not valid JSON: [$RUN_OUT]"
		return
	}
	if [ "$decision" != "block" ]; then
		fail "$name" "decision was [$decision], expected block"
		return
	fi
	reason="$(printf '%s' "$RUN_OUT" | jq -r '.reason' 2>/dev/null)"
	if [ -z "$reason" ] || [ "$reason" = "null" ]; then
		fail "$name" "block carried no reason"
		return
	fi
	pass "$name"
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

# state_field <goal-folder> <field> — empty when absent.
state_field() {
	bash "$LOOP_STATE" get "$(loop_file "$1")" "$2" 2>/dev/null || printf ''
}

# assert_no_record <name> <goal-folder>
assert_no_record() {
	if [ -e "$2/.goal-gate/completion-record.md" ]; then
		fail "$1" "a completion record was written on a non-completion path"
	else
		pass "$1"
	fi
}

# ---- fixture bodies -------------------------------------------------------
#
# Written once and reused, so that "met" and "unmet" differ by exactly the
# thing under test and nothing else.

write_all_met() {
	acs "$1" <<'EOF'
# Acceptance criteria

- [x] **CRITICAL** A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
      - at: 2026-07-19T14:02:11Z
- [x] Counting is delegated, never duplicated — `.claude/skills/goal-gate/validate-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
EOF
}

write_one_unmet() {
	acs "$1" <<'EOF'
# Acceptance criteria

- [x] A zero-criteria file is rejected — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash parse-acs.sh fixtures/empty.md` printed `no criteria found` (exit 2)
- [x] Counting is delegated, never duplicated — `.claude/skills/goal-gate/validate-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
- [ ] The installer is idempotent — `.claude/skills/goal-gate/install.sh`
      - explanation: the second-run assertion has not been written yet
EOF
}

printf '== goal-gate completion decision (T2.2) conformance suite ==\n'
printf 'gate: %s\n\n' "$GATE"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FATAL: jq is required by this suite (the gate refuses without it).\n' >&2
	exit 1
fi

# ===========================================================================
printf -- '-- 1. Happy path: PERMIT (this section is what stops a gate that only refuses) --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"permit1"}'

assert_permits "happy/all-criteria-met-and-evidenced-permits-completion"
# A permit does not BLOCK; it does announce itself to the operator, who would
# otherwise have no signal that the goal finished rather than the loop dying.
case "$RUN_OUT" in
*'"decision"'*) fail "happy/permit-emits-no-decision" "stdout was [$RUN_OUT]" ;;
*) pass "happy/permit-emits-no-decision" ;;
esac
case "$RUN_OUT" in
*'systemMessage'*'GOAL COMPLETE'*) pass "happy/permit-tells-the-operator-the-goal-is-complete" ;;
*) fail "happy/permit-tells-the-operator-the-goal-is-complete" "stdout was [$RUN_OUT]" ;;
esac
assert_equals "happy/permit-exits-0" "0" "$RUN_STATUS"

if [ -f "$GOAL/.goal-gate/completion-record.md" ]; then
	pass "happy/completion-record-is-written"
else
	fail "happy/completion-record-is-written" "no completion-record.md in $GOAL/.goal-gate"
fi

RECORD="$(cat "$GOAL/.goal-gate/completion-record.md" 2>/dev/null)"
case "$RECORD" in
*'decision: permitted'*) pass "happy/record-states-the-decision" ;;
*) fail "happy/record-states-the-decision" "record: [$RECORD]" ;;
esac
case "$RECORD" in
*'A zero-criteria file is rejected'*) pass "happy/record-names-the-criteria" ;;
*) fail "happy/record-names-the-criteria" "criterion text absent from the record" ;;
esac
case "$RECORD" in
*'bash tests/test-parse-acs.sh'*) pass "happy/record-names-the-evidence" ;;
*) fail "happy/record-names-the-evidence" "evidence text absent from the record" ;;
esac
case "$RECORD" in
*'decision=met'*) pass "happy/record-carries-the-per-criterion-trail" ;;
*) fail "happy/record-carries-the-per-criterion-trail" "no per-criterion trail in the record" ;;
esac
case "$RECORD" in
*'total: 2'*) pass "happy/record-carries-the-counts" ;;
*) fail "happy/record-carries-the-counts" "no counts in the record" ;;
esac

assert_equals "happy/state-records-the-permit" "permitted" "$(state_field "$GOAL" decision)"
assert_equals "happy/state-records-the-verdict" "done" "$(state_field "$GOAL" acs_verdict)"
assert_equals "happy/state-records-the-total" "2" "$(state_field "$GOAL" acs_total)"
assert_equals "happy/state-records-nothing-unchecked" "0" "$(state_field "$GOAL" acs_unchecked)"
assert_equals "happy/state-records-no-unevidenced-tick" "0" "$(state_field "$GOAL" acs_ticked_without_evidence)"
assert_equals "happy/state-records-the-evaluation-outcome" "met" "$(state_field "$GOAL" evaluation_state)"

# Both delegated evaluations must have RUN. A permit whose delegates never ran
# is exactly the ancestor's defect, and the recorded exit codes are the proof.
assert_equals "happy/parser-actually-ran" "0" "$(state_field "$GOAL" acs_parse_rc)"
assert_equals "happy/evidence-validator-actually-ran" "0" "$(state_field "$GOAL" acs_validate_rc)"

case "$(state_field "$GOAL" criteria_trail)" in
*'criterion line='*) pass "happy/per-criterion-trail-is-reconstructable-from-state" ;;
*) fail "happy/per-criterion-trail-is-reconstructable-from-state" "no trail in the loop file" ;;
esac

# A permit RETIRES the workstream for the purposes of BINDING — nobody else may
# adopt it — without making the permit a one-shot for its owner. The two are
# separate properties and the "discipline" section below pins the second; this
# pins the write that the first depends on.
assert_equals "finished/the-permit-records-the-terminal-status" \
	"complete" "$(state_field "$GOAL" status)"

# The Codex-shaped payload must reach the SAME decision through the same file.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"turn_id":"t-abc","last_assistant_message":"done"}'
assert_permits "happy/codex-shaped-payload-permits-identically"
if [ -f "$GOAL/.goal-gate/completion-record.md" ]; then
	pass "happy/codex-permit-writes-a-record-too"
else
	fail "happy/codex-permit-writes-a-record-too" "no completion record for the Codex shape"
fi

# ===========================================================================
printf -- '-- 2. Happy path: one criterion unmet -> REFUSE naming the count ---\n'
# ===========================================================================

GOAL="$(new_goal)"
write_one_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"unmet1"}'

assert_refuses "unmet/one-unmet-criterion-refuses-completion"
assert_valid_json_block "unmet/refusal-is-a-well-formed-decision"
assert_reason_mentions "unmet/reason-names-the-unmet-count" "1 of 3"
assert_reason_mentions "unmet/reason-names-the-met-count" "2 met"
assert_no_record "unmet/no-completion-record-on-a-refusal" "$GOAL"
assert_equals "unmet/state-records-the-refusal" "refused_unmet" "$(state_field "$GOAL" decision)"
assert_equals "unmet/state-preserves-the-unmet-count" "1" "$(state_field "$GOAL" acs_unchecked)"
assert_equals "unmet/state-preserves-the-checked-count" "2" "$(state_field "$GOAL" acs_checked)"
assert_equals "unmet/evaluation-outcome-is-unmet" "unmet" "$(state_field "$GOAL" evaluation_state)"

# ===========================================================================
printf -- '-- 3. Invalid input: the parser returned an error -> REFUSE --------\n'
# ===========================================================================

# 3a. A real parse refusal: an unrecognised checkbox state. The parser exits 4
# and must never be read as "nothing outstanding".
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [~] Something in a state the parser will not guess — `.claude/skills/goal-gate/x.sh`
      - evidence: `bash x.sh` printed ok (exit 0)
EOF
gate_run "$GOAL" '{"session_id":"parseerr"}'
assert_refuses "parse-error/an-unrecognised-checkbox-refuses"
assert_reason_lacks "parse-error/refusal-is-not-dressed-up-as-completion" '"decision":"allow"'
assert_no_record "parse-error/no-completion-record-after-a-parse-error" "$GOAL"

# 3b. Merge-conflict markers (parser exit 6).
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] A criterion — `.claude/skills/goal-gate/x.sh`
      - evidence: `bash x.sh` printed ok (exit 0)
<<<<<<< HEAD
- [x] Another — `.claude/skills/goal-gate/y.sh`
=======
- [ ] Another — `.claude/skills/goal-gate/y.sh`
>>>>>>> branch
EOF
gate_run "$GOAL" '{"session_id":"conflict"}'
assert_refuses "parse-error/merge-conflict-markers-refuse"
assert_no_record "parse-error/no-record-after-conflict-markers" "$GOAL"

# 3c. A parser that exits with a code outside its documented set. That is not a
# verdict; it is a check that could not run.
GOAL="$(new_goal)"
write_all_met "$GOAL"
STUB="$WORK_DIR/parser-exits-99.sh"
cat >"$STUB" <<'STUBEOF'
#!/usr/bin/env bash
printf 'verdict=done\ntotal=2\nchecked=2\nunchecked=0\n'
exit 99
STUBEOF
gate_run "$GOAL" '{"session_id":"rc99"}' "GOAL_GATE_PARSE_ACS=$STUB"
assert_refuses "parse-error/an-undocumented-exit-code-refuses"
assert_reason_mentions "parse-error/undocumented-exit-is-reported-as-not-run" "not-run"
assert_no_record "parse-error/no-record-after-an-undocumented-exit" "$GOAL"

# 3d. The ACs.md is a directory, not a readable checklist. A self-bound
# conversation (it claimed no `_anon-*` workstream) has no goal to pursue where
# it stands — a directory is not an acceptance checklist any more than a missing
# file is — so the gate STANDS DOWN rather than refusing. A real driver, which
# OWNS a claimed workstream, still refuses on a broken criteria file; the
# stand-down is only for a conversation that was never pursuing a goal here.
GOAL="$(new_goal)"
mkdir -p "$GOAL/ACs.md"
gate_run "$GOAL" '{"session_id":"acsdir"}'
assert_silent "parse-error/a-directory-in-place-of-the-criteria-file-stands-down"
assert_no_record "parse-error/no-record-when-the-criteria-file-is-a-directory" "$GOAL"

# ===========================================================================
printf -- '-- 4. Empty / null: zero criteria (the vacuous-truth trap) ---------\n'
# ===========================================================================

GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
# Acceptance criteria

Nothing here yet.
EOF
gate_run "$GOAL" '{"session_id":"zero1"}'
assert_refuses "vacuous/zero-criteria-refuses-completion"
assert_no_record "vacuous/zero-criteria-writes-no-completion-record" "$GOAL"
assert_equals "vacuous/zero-criteria-is-not-recorded-as-permitted" \
	"refused_not_run" "$(state_field "$GOAL" decision)"

GOAL="$(new_goal)"
: >"$GOAL/ACs.md"
gate_run "$GOAL" '{"session_id":"zero2"}'
assert_refuses "vacuous/an-empty-criteria-file-refuses"
assert_no_record "vacuous/an-empty-file-writes-no-record" "$GOAL"

# A missing criteria file is not the vacuous-truth trap (an EMPTY checklist,
# above, still refuses). It means no goal is being pursued where this self-bound
# conversation stands, so the gate STANDS DOWN silently and writes nothing —
# which, like a refusal, permits no completion, so the vacuous-truth guarantee
# is intact either way.
GOAL="$(new_goal)"
gate_run "$GOAL" '{"session_id":"zero3"}'
assert_silent "vacuous/a-missing-criteria-file-stands-down"
assert_no_record "vacuous/a-missing-file-writes-no-record" "$GOAL"

# A gate that permitted on zero criteria would also permit here: a file whose
# only task items are NESTED illustrations, with no top-level criterion at all.
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
# Acceptance criteria

Some prose.

  - [x] an indented illustration, not a criterion
  - [x] another illustration
EOF
gate_run "$GOAL" '{"session_id":"zero4"}'
assert_refuses "vacuous/nested-items-only-is-still-zero-criteria"
assert_no_record "vacuous/nested-items-only-writes-no-record" "$GOAL"

# ===========================================================================
printf -- '-- 5. Error propagation: a check that could not run is NOT a pass (D1) --\n'
# ===========================================================================
#
# THE MARQUEE FIX. The ancestor ran its verification as `claude -p 2>/dev/null`
# and consumed the empty result as a pass. Each case below is a check that could
# not run; every one of them must REFUSE and say `not-run`.

# 5a. The parser is absent entirely.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"noparser"}' "GOAL_GATE_PARSE_ACS=$WORK_DIR/does-not-exist.sh"
assert_refuses "d1/an-absent-parser-refuses"
assert_reason_mentions "d1/absent-parser-is-reported-as-not-run" "not-run"
assert_no_record "d1/an-absent-parser-writes-no-record" "$GOAL"

# 5b. The evidence validator is absent.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"novalidator"}' "GOAL_GATE_VALIDATE_ACS=$WORK_DIR/does-not-exist.sh"
assert_refuses "d1/an-absent-evidence-validator-refuses"
assert_reason_mentions "d1/absent-validator-is-reported-as-not-run" "not-run"
assert_no_record "d1/an-absent-validator-writes-no-record" "$GOAL"

# 5c. THE ANCESTOR'S EXACT SHAPE: exit 0, empty stdout. Silence is not consent.
GOAL="$(new_goal)"
write_all_met "$GOAL"
SILENT="$WORK_DIR/silent-success.sh"
cat >"$SILENT" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF
gate_run "$GOAL" '{"session_id":"silent1"}' "GOAL_GATE_PARSE_ACS=$SILENT"
assert_refuses "d1/exit-0-with-empty-output-refuses-rather-than-passing"
assert_reason_mentions "d1/silent-success-is-reported-as-not-run" "not-run"
assert_no_record "d1/silent-success-writes-no-record" "$GOAL"

gate_run "$GOAL" '{"session_id":"silent2"}' "GOAL_GATE_VALIDATE_ACS=$SILENT"
assert_refuses "d1/a-silent-evidence-validator-refuses-too"
assert_reason_mentions "d1/silent-validator-is-reported-as-not-run" "not-run"

# 5d. Exit 0 with output that is not the agreed shape (no verdict, no counts).
GOAL="$(new_goal)"
write_all_met "$GOAL"
GARBAGE="$WORK_DIR/garbage-success.sh"
cat >"$GARBAGE" <<'STUBEOF'
#!/usr/bin/env bash
printf 'everything looks fine to me\n'
exit 0
STUBEOF
gate_run "$GOAL" '{"session_id":"garbage"}' "GOAL_GATE_PARSE_ACS=$GARBAGE"
assert_refuses "d1/unparseable-delegate-output-refuses"
assert_reason_mentions "d1/unparseable-output-is-reported-as-not-run" "not-run"

# 5e. Exit 0 claiming done but with a non-numeric total — a shape the gate does
# not understand must not be coerced into a number.
GOAL="$(new_goal)"
write_all_met "$GOAL"
BADCOUNT="$WORK_DIR/bad-count.sh"
cat >"$BADCOUNT" <<'STUBEOF'
#!/usr/bin/env bash
printf 'verdict=done\ntotal=all\nchecked=all\nunchecked=none\n'
exit 0
STUBEOF
gate_run "$GOAL" '{"session_id":"badcount"}' "GOAL_GATE_PARSE_ACS=$BADCOUNT"
assert_refuses "d1/non-numeric-counts-refuse"
assert_no_record "d1/non-numeric-counts-write-no-record" "$GOAL"

# 5f. The two delegates disagree about the file they read. Neither is
# trustworthy, so neither is believed.
GOAL="$(new_goal)"
write_all_met "$GOAL"
LIAR="$WORK_DIR/liar.sh"
cat >"$LIAR" <<'STUBEOF'
#!/usr/bin/env bash
printf 'verdict=done\ntotal=9\nchecked=9\nunchecked=0\nunknown=0\n'
exit 0
STUBEOF
gate_run "$GOAL" '{"session_id":"disagree"}' "GOAL_GATE_PARSE_ACS=$LIAR"
assert_refuses "d1/delegates-disagreeing-about-the-file-refuses"
assert_reason_mentions "d1/disagreement-is-reported-as-not-run" "not-run"
assert_no_record "d1/disagreement-writes-no-record" "$GOAL"

# 5g. The refusal is still a well-formed decision on every not-run path, or the
# agent cannot act on it.
assert_valid_json_block "d1/a-not-run-refusal-is-still-a-well-formed-decision"

# 5h. Every not-run path records that it could not run, so the trail is
# reconstructable afterwards (S38/S39).
assert_equals "d1/state-records-the-not-run-refusal" \
	"refused_not_run" "$(state_field "$GOAL" decision)"
assert_equals "d1/state-records-that-the-evaluation-errored" \
	"error" "$(state_field "$GOAL" evaluation_state)"

# ===========================================================================
printf -- '-- 6. Boundary: exactly one criterion ------------------------------\n'
# ===========================================================================

GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] The single criterion is met — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
EOF
gate_run "$GOAL" '{"session_id":"one-met"}'
assert_permits "boundary/exactly-one-criterion-met-permits"
assert_equals "boundary/one-met-total-is-1" "1" "$(state_field "$GOAL" acs_total)"
if [ -f "$GOAL/.goal-gate/completion-record.md" ]; then
	pass "boundary/one-met-writes-a-completion-record"
else
	fail "boundary/one-met-writes-a-completion-record" "no record"
fi

GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [ ] The single criterion is not met — `.claude/skills/goal-gate/parse-acs.sh`
      - explanation: the suite has not been written yet
EOF
gate_run "$GOAL" '{"session_id":"one-unmet"}'
assert_refuses "boundary/exactly-one-criterion-unmet-refuses"
assert_reason_mentions "boundary/one-unmet-reason-names-the-count" "1 of 1"
assert_no_record "boundary/one-unmet-writes-no-record" "$GOAL"

# ===========================================================================
printf -- '-- 7. Security: criterion text is never evaluated as shell ---------\n'
# ===========================================================================

CANARY="$WORK_DIR/canary-must-not-exist"
rm -f "$CANARY"

GOAL="$(new_goal)"
acs "$GOAL" <<EOF
- [ ] \$(touch $CANARY) and \`touch $CANARY\` and ; touch $CANARY ; — \`.claude/skills/goal-gate/x.sh\`
      - explanation: \$(touch $CANARY) still not done
- [ ] \$\{IFS\}&& touch $CANARY || true — \`.claude/skills/goal-gate/y.sh\`
      - explanation: rm -rf / && touch $CANARY
EOF
gate_run "$GOAL" '{"session_id":"shellinj"}'
assert_refuses "security/hostile-criterion-text-still-produces-a-decision"
if [ -e "$CANARY" ]; then
	fail "security/criterion-text-was-not-executed" "the canary file was created — criterion text reached a shell"
else
	pass "security/criterion-text-was-not-executed"
fi
assert_valid_json_block "security/the-reason-is-still-valid-json-with-hostile-input"

# A criterion whose text contains a double quote and a backslash must not break
# the JSON the agent has to parse.
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [ ] A "quoted" \ backslashed criterion — `.claude/skills/goal-gate/x.sh`
      - explanation: not yet
EOF
gate_run "$GOAL" '{"session_id":"quotes"}'
assert_refuses "security/quotes-and-backslashes-in-criteria-still-refuse"
assert_valid_json_block "security/quotes-and-backslashes-do-not-break-the-json"

# The path to the criteria file is attacker-adjacent too: a folder name holding
# a quote must not escape the JSON string. A checklist is seeded so the gate
# reaches a JSON refusal whose reason carries that path — the stand-down for a
# goalless tree would emit no JSON and so would not exercise the escaping.
GOAL="$(mktemp -d "$WORK_DIR/go\"al.XXXXXX")"
mkdir -p "$GOAL/.goal-gate"
acs "$GOAL" <<'EOF'
- [ ] A criterion in a quoted path — `x`
      - explanation: not yet
EOF
gate_run "$GOAL" '{"session_id":"pathquote"}'
assert_refuses "security/a-quote-in-the-goal-path-still-refuses"
assert_valid_json_block "security/a-quote-in-the-goal-path-does-not-break-the-json"

# ===========================================================================
printf -- '-- 8. Timing: the budget is the TIGHTEST host timeout (R3) ---------\n'
# ===========================================================================

# 8a. A representative file decides well inside the 120 s budget. Measured, not
# asserted from belief.
GOAL="$(new_goal)"
write_all_met "$GOAL"
T_START="$SECONDS"
gate_run "$GOAL" '{"session_id":"timely"}'
T_ELAPSED=$((SECONDS - T_START))
assert_permits "timing/a-representative-file-decides-and-permits"
if [ "$T_ELAPSED" -lt 120 ]; then
	pass "timing/decision-lands-inside-the-120s-budget"
else
	fail "timing/decision-lands-inside-the-120s-budget" "took ${T_ELAPSED}s"
fi

# 8b. Overrunning the budget is a REPORTED FAILURE, never a silent permit. The
# delegate hangs; the gate must stop it and refuse.
GOAL="$(new_goal)"
write_all_met "$GOAL"
HANG="$WORK_DIR/hangs.sh"
# The delegate sleeps far longer than the threshold this test checks against.
#
# It used to sleep 8s and assert elapsed < 8s, which measured TOTAL elapsed
# time — so machine load, not the gate's behaviour, decided the verdict: the
# suite passed 167/0 alone and failed 166/1 when several suites ran together.
# A test whose answer depends on what else is running is not reporting on the
# code.
#
# The property under test is binary — did the gate cut the delegate off, or did
# it wait for it? — so the fix is a margin wide enough that load cannot cross
# it. Enforced, this lands in ~1-2s; unenforced, in ~60s. The 30s threshold is
# nowhere near either, and the long sleep only costs anything on the failure
# path, which is the right way round.
cat >"$HANG" <<'STUBEOF'
#!/usr/bin/env bash
sleep 60
printf 'verdict=done\ntotal=2\nchecked=2\nunchecked=0\n'
exit 0
STUBEOF
T_START="$SECONDS"
gate_run "$GOAL" '{"session_id":"hang1"}' \
	"GOAL_GATE_PARSE_ACS=$HANG" "GOAL_GATE_DECISION_BUDGET=1"
T_ELAPSED=$((SECONDS - T_START))
assert_refuses "timing/exceeding-the-budget-refuses"
assert_reason_mentions "timing/the-overrun-is-reported-not-silent" "budget"
assert_reason_mentions "timing/an-overrun-check-is-reported-as-not-run" "not-run"
assert_no_record "timing/an-overrun-writes-no-completion-record" "$GOAL"
if [ "$T_ELAPSED" -lt 30 ]; then
	pass "timing/the-gate-enforces-the-budget-itself"
else
	fail "timing/the-gate-enforces-the-budget-itself" \
		"took ${T_ELAPSED}s — the delegate ran to completion instead of being stopped"
fi

# 8c. A hanging EVIDENCE validator is the same reported failure. A gate that
# only bounded the parser would leave the more expensive check unbounded.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"hang2"}' \
	"GOAL_GATE_VALIDATE_ACS=$HANG" "GOAL_GATE_DECISION_BUDGET=1"
assert_refuses "timing/a-hanging-evidence-validator-also-refuses"
assert_reason_mentions "timing/hanging-validator-is-reported-as-not-run" "not-run"
# The refusal must be attributed to THE BUDGET, not merely to some downstream
# symptom. Without this the gate could stop enforcing the bound and still pass,
# because a fabricated result from a killed delegate would be caught later by
# the parser/validator cross-check and refused for the wrong reason — a
# surviving mutant proved exactly that during the non-vacuity check.
assert_reason_mentions "timing/hanging-validator-refusal-names-the-budget" "budget"
assert_no_record "timing/a-hanging-validator-writes-no-record" "$GOAL"

# The BOTH-delegates-hang case: the budget must still be what stops it, and the
# outcome must still be a refusal rather than a decision inherited from
# whichever fabricated output happened to be lying around.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"hang3"}' \
	"GOAL_GATE_PARSE_ACS=$HANG" "GOAL_GATE_VALIDATE_ACS=$HANG" \
	"GOAL_GATE_DECISION_BUDGET=1"
assert_refuses "timing/both-delegates-hanging-refuses"
assert_reason_mentions "timing/both-hanging-refusal-names-the-budget" "budget"
assert_no_record "timing/both-hanging-writes-no-record" "$GOAL"

# 8d. The default budget, with nothing set, is 120 — the Claude registration's
# timeout, NOT Codex's 600 s default. Asserted from the shipped source, because
# a default that drifts to 600 is invisible in every other test here.
if grep -qE 'GOAL_GATE_DECISION_BUDGET:-120' "$GATE"; then
	pass "timing/default-budget-is-the-tightest-host-timeout-120s"
else
	fail "timing/default-budget-is-the-tightest-host-timeout-120s" \
		"the default budget in $GATE is not 120"
fi
if grep -qE 'GOAL_GATE_DECISION_BUDGET:-600' "$GATE"; then
	fail "timing/budget-is-not-codex-600s-default" "the budget defaults to 600"
else
	pass "timing/budget-is-not-codex-600s-default"
fi

# 8e. A nonsense budget falls back to the default rather than disabling the
# bound. A budget of "abc" that evaluated to 0 would make every decision an
# instant timeout; one that evaluated to "unlimited" would remove the guard.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"badbudget"}' "GOAL_GATE_DECISION_BUDGET=not-a-number"
assert_permits "timing/a-nonsense-budget-falls-back-to-the-default"

GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"zerobudget"}' "GOAL_GATE_DECISION_BUDGET=0"
assert_permits "timing/a-zero-budget-falls-back-to-the-default"

# ===========================================================================
printf -- '-- 9. Invalid input: ticked with NO evidence -> ticked-without-evidence (R12) --\n'
# ===========================================================================
#
# The single most important rule in the feature: it is what stops a
# self-certified tick. Delegated to validate-acs.sh (T1.6).

GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] I have decided this is done — `.claude/skills/goal-gate/x.sh`
- [x] And so is this — `.claude/skills/goal-gate/y.sh`
EOF
gate_run "$GOAL" '{"session_id":"twe1"}'
assert_refuses "r12/a-tick-with-no-evidence-block-refuses"
assert_reason_mentions "r12/refusal-names-ticked-without-evidence" "ticked-without-evidence"
assert_no_record "r12/an-unevidenced-tick-writes-no-record" "$GOAL"
assert_valid_json_block "r12/the-refusal-is-a-well-formed-decision"

# One evidenced, one not. The evidenced one must not carry the other through.
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] Properly evidenced — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
- [x] Self-certified — `.claude/skills/goal-gate/y.sh`
EOF
gate_run "$GOAL" '{"session_id":"twe2"}'
assert_refuses "r12/one-unevidenced-tick-among-evidenced-ones-still-refuses"
assert_reason_mentions "r12/mixed-case-still-names-ticked-without-evidence" "ticked-without-evidence"
assert_no_record "r12/mixed-case-writes-no-record" "$GOAL"

# An empty evidence value is not evidence.
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] Evidence line present but empty — `.claude/skills/goal-gate/x.sh`
      - evidence:
EOF
gate_run "$GOAL" '{"session_id":"twe3"}'
assert_refuses "r12/an-empty-evidence-value-refuses"
assert_no_record "r12/an-empty-evidence-value-writes-no-record" "$GOAL"

# Evidence that is prose alone, naming no command and no observed result.
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] It works, I checked — `.claude/skills/goal-gate/x.sh`
      - evidence: it seems fine to me
EOF
gate_run "$GOAL" '{"session_id":"prose"}'
assert_refuses "r12/prose-only-evidence-refuses"
assert_no_record "r12/prose-only-evidence-writes-no-record" "$GOAL"

# Evidence naming a surrogate — a tick evidenced by a mock is not evidence of
# the specified system. Note the surrogate must be the BACKTICKED REFERENCE:
# T1.6 scopes the §3.3 vocabulary to the named artefact, so prose merely
# mentioning a mock beside a real-looking command is NOT caught (recorded in
# the T2.2 journal as a real limit of the evidence rule, not a gate defect).
GOAL="$(new_goal)"
acs "$GOAL" <<'EOF'
- [x] The gate refuses correctly — `.claude/skills/goal-gate/x.sh`
      - evidence: `bash tests/mock-gate-run.sh` reported 3/3 PASS (exit 0)
EOF
gate_run "$GOAL" '{"session_id":"surrogate"}'
assert_refuses "r12/evidence-naming-a-surrogate-refuses"
assert_no_record "r12/surrogate-evidence-writes-no-record" "$GOAL"

# ===========================================================================
printf -- '-- 10. State transitions: LOOP_BLOCKED is a reported NON-COMPLETION (R5) --\n'
# The signal file is KEYED to its workstream: `<workstream>.LOOP_BLOCKED`, where
# the workstream is the session id the gate was called with. A bare
# `LOOP_BLOCKED` binds nobody and is covered separately in section 10f.
# ===========================================================================

# 10a. Raised with a written reason, criteria still unmet: the loop TERMINATES,
# and reports a non-completion.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
printf 'the upstream API credentials have not been issued\n' >"$GOAL/.goal-gate/blocked1.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blocked1"}'
assert_terminal_non_completion "r5/loop-blocked-terminates-the-loop"
assert_no_record "r5/loop-blocked-writes-no-completion-record" "$GOAL"
assert_equals "r5/loop-blocked-is-recorded-as-its-own-decision" \
	"loop_blocked" "$(state_field "$GOAL" decision)"
assert_equals "r5/loop-blocked-preserves-the-unmet-count" \
	"1" "$(state_field "$GOAL" acs_unchecked)"
assert_equals "r5/loop-blocked-preserves-the-unmet-count-at-block" \
	"1" "$(state_field "$GOAL" unmet_at_block)"
assert_equals "r5/loop-blocked-does-not-mark-the-verdict-done" \
	"not_done" "$(state_field "$GOAL" acs_verdict)"
assert_equals "r5/loop-blocked-does-not-mark-the-evaluation-met" \
	"unmet" "$(state_field "$GOAL" evaluation_state)"
case "$(state_field "$GOAL" blocked_reason)" in
*'credentials have not been issued'*) pass "r5/the-written-reason-is-recorded" ;;
*) fail "r5/the-written-reason-is-recorded" "reason not preserved in the loop file" ;;
esac
case "$RUN_ERR" in
*'credentials have not been issued'*) pass "r5/the-written-reason-is-reported" ;;
*) fail "r5/the-written-reason-is-reported" "err=[$RUN_ERR]" ;;
esac
case "$RUN_ERR" in
*'not a pass'*) pass "r5/the-report-says-plainly-it-is-not-a-pass" ;;
*) fail "r5/the-report-says-plainly-it-is-not-a-pass" "err=[$RUN_ERR]" ;;
esac

# 10b. Raised with NO written reason: not honoured. A blocker that can be
# declared by `touch` alone is a one-command exit from the whole contract.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
: >"$GOAL/.goal-gate/blocked2.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blocked2"}'
assert_refuses "r5/a-blocked-signal-with-no-reason-is-refused-not-honoured"
assert_reason_mentions "r5/refusal-says-the-blocker-carried-no-reason" "no written reason"
assert_no_record "r5/an-unreasoned-blocker-writes-no-record" "$GOAL"
assert_equals "r5/an-unreasoned-blocker-is-recorded-as-such" \
	"blocked_without_reason" "$(state_field "$GOAL" decision)"

# Whitespace is not a reason.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
printf '   \n\t\n' >"$GOAL/.goal-gate/blocked3.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blocked3"}'
assert_refuses "r5/a-whitespace-only-reason-is-not-a-reason"
assert_no_record "r5/a-whitespace-only-reason-writes-no-record" "$GOAL"

# 10c. LOOP_BLOCKED raised when every criterion IS met and evidenced. Blocked
# still wins: it never emits a completion record, whatever the criteria say.
GOAL="$(new_goal)"
write_all_met "$GOAL"
printf 'the reviewer withdrew sign-off\n' >"$GOAL/.goal-gate/blocked4.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blocked4"}'
assert_terminal_non_completion "r5/loop-blocked-beats-a-fully-met-checklist"
assert_no_record "r5/loop-blocked-never-emits-a-record-even-when-all-met" "$GOAL"
assert_equals "r5/loop-blocked-is-not-recorded-as-permitted" \
	"loop_blocked" "$(state_field "$GOAL" decision)"

# 10d. The signal is also honoured through the loop-state file, which is how a
# skill raises it without touching the gate directory's layout.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"blocked5"}'
assert_refuses "r5/precondition-the-workstream-refuses-before-being-blocked"
LF="$(loop_file "$GOAL")"
bash "$LOOP_STATE" set "$LF" status LOOP_BLOCKED >/dev/null 2>&1
bash "$LOOP_STATE" set "$LF" blocked_reason "the hardware under test is in for repair" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"blocked5"}'
assert_terminal_non_completion "r5/loop-blocked-via-state-terminates-too"
assert_no_record "r5/loop-blocked-via-state-writes-no-record" "$GOAL"

# 10e. A blocked workstream whose criteria file is itself broken must still be
# brought to a reported end, not blocked forever.
GOAL="$(new_goal)"
printf 'the criteria file was lost in a bad rebase\n' >"$GOAL/.goal-gate/blocked6.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"blocked6"}'
assert_terminal_non_completion "r5/a-blocked-workstream-with-no-criteria-file-still-terminates"
assert_no_record "r5/that-termination-writes-no-record" "$GOAL"

# 10f. A BARE `LOOP_BLOCKED` left by a version that predates the keyed name.
# Reported with the exact correction, honoured for NOBODY, and evaluation
# continues normally. The asymmetry is deliberate: honouring an unattributable
# signal ends a loop that should be running — the defect — whereas declining
# leaves a loop running that someone meant to stop, which is visible and
# re-reported every turn.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
printf 'a blocker from an older version\n' >"$GOAL/.goal-gate/LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"legacy1"}'
assert_refuses "r5/a-bare-legacy-signal-is-not-honoured"
assert_no_record "r5/a-bare-legacy-signal-writes-no-completion-record" "$GOAL"
assert_equals "r5/a-bare-legacy-signal-leaves-normal-evaluation-running" \
	"refused_unmet" "$(state_field "$GOAL" decision)"
case "$RUN_ERR" in
*'NOT honoured'*) pass "r5/a-bare-legacy-signal-is-reported" ;;
*) fail "r5/a-bare-legacy-signal-is-reported" "err=[$RUN_ERR]" ;;
esac
case "$RUN_ERR" in
*'mv '*'/LOOP_BLOCKED '*'legacy1.LOOP_BLOCKED'*)
	pass "r5/the-legacy-report-gives-the-exact-correction" ;;
*) fail "r5/the-legacy-report-gives-the-exact-correction" "err=[$RUN_ERR]" ;;
esac

# 10g. One workstream's blocker binds ONE workstream. Two loops share a gate
# directory; blocking the first must leave the second evaluated normally. This
# is the whole point of keying the file.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"wsA"}'
assert_refuses "r5/precondition-workstream-A-is-running"
gate_run "$GOAL" '{"session_id":"wsB"}'
assert_refuses "r5/precondition-workstream-B-is-running"
printf 'A is waiting on an external vendor\n' >"$GOAL/.goal-gate/wsA.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"wsA"}'
assert_terminal_non_completion "r5/blocking-A-ends-A"
gate_run "$GOAL" '{"session_id":"wsB"}'
assert_refuses "r5/blocking-A-leaves-B-evaluated-normally"
assert_no_record "r5/blocking-A-writes-no-record-for-B" "$GOAL"

# ===========================================================================
printf -- '-- 10h. LOOP_PARTIAL: the remaining work is BLOCKED (T3.1) --\n'
# ===========================================================================
#
# The ending this feature exists for. Every criterion is either met and
# evidenced or explicitly blocked with a reason; none is outstanding. Before
# this, the loop had no ending for that shape and refused every turn forever.

# write_partial <goal> — one met-and-evidenced criterion, one blocked with a
# stated reason, nothing outstanding.
write_partial() {
	cat >"$1/ACs.md" <<'ACSEOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] **CRITICAL** The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials this run does not have and cannot mint.
ACSEOF
}

GOAL="$(new_goal)"
write_partial "$GOAL"
gate_run "$GOAL" '{"session_id":"partial1"}'
assert_terminal_non_completion "partial/an-all-blocked-remainder-ends-the-loop"
assert_no_record "partial/a-partial-ending-writes-no-completion-record" "$GOAL"
assert_equals "partial/it-is-recorded-as-its-own-decision" \
	"loop_partial" "$(state_field "$GOAL" decision)"
assert_equals "partial/the-status-retires-the-workstream" \
	"LOOP_PARTIAL" "$(state_field "$GOAL" status)"
assert_equals "partial/the-blocked-count-is-recorded" \
	"1" "$(state_field "$GOAL" acs_blocked)"
case "$RUN_ERR" in
*'LOOP_PARTIAL'*) pass "partial/the-report-names-the-ending" ;;
*) fail "partial/the-report-names-the-ending" "err=[$RUN_ERR]" ;;
esac
case "$RUN_ERR" in
*'NOT a pass'*) pass "partial/the-report-says-plainly-it-is-not-a-pass" ;;
*) fail "partial/the-report-says-plainly-it-is-not-a-pass" "err=[$RUN_ERR]" ;;
esac
case "$RUN_ERR" in
*'production credentials'*) pass "partial/the-report-names-the-reason" ;;
*) fail "partial/the-report-names-the-reason" "err=[$RUN_ERR]" ;;
esac
# A blocked CRITICAL is distinguished from a blocked minor item: "the
# load-bearing criterion is blocked" is a different report.
case "$RUN_ERR" in
*'CRITICAL: The staging smoke test'*) pass "partial/a-blocked-critical-is-marked-as-critical" ;;
*) fail "partial/a-blocked-critical-is-marked-as-critical" "err=[$RUN_ERR]" ;;
esac

# Terminal: a LATER turn stands down rather than re-evaluating. Only `complete`
# is ever re-evaluated.
gate_run "$GOAL" '{"session_id":"partial1"}'
assert_no_record "partial/a-later-turn-writes-no-record" "$GOAL"
case "$RUN_ERR" in
*'already reached a reported END'*) pass "partial/a-later-turn-stands-down" ;;
*) fail "partial/a-later-turn-stands-down" "err=[$RUN_ERR]" ;;
esac

# BOUNDARY, and the one that matters most: outstanding work OUTRANKS blocked
# work. Blocking SOME criteria never releases a turn that still has real work.
GOAL="$(new_goal)"
cat >"$GOAL/ACs.md" <<'ACSEOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
- [ ] The report is written — `scripts/report.sh`
      - explanation: not started.
ACSEOF
gate_run "$GOAL" '{"session_id":"partial2"}'
assert_refuses "partial/outstanding-plus-blocked-is-an-ordinary-refusal"
assert_no_record "partial/outstanding-plus-blocked-writes-no-record" "$GOAL"
assert_equals "partial/outstanding-plus-blocked-is-not-partial" \
	"refused_unmet" "$(state_field "$GOAL" decision)"

# BOUNDARY: every criterion blocked, nothing met. Still a partial, and still
# not a pass — the vacuous-truth trap in its new form.
GOAL="$(new_goal)"
cat >"$GOAL/ACs.md" <<'ACSEOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
- [!] The load test completes — `scripts/load.sh`
      - blocked: the load rig is decommissioned.
ACSEOF
gate_run "$GOAL" '{"session_id":"partial3"}'
assert_terminal_non_completion "partial/an-all-blocked-checklist-ends-the-loop"
assert_no_record "partial/an-all-blocked-checklist-writes-no-record" "$GOAL"
assert_equals "partial/an-all-blocked-checklist-marks-nothing-met" \
	"0" "$(state_field "$GOAL" acs_checked)"

# NEGATIVE: a reasonless blocker does NOT release the turn. Without this, `[!]`
# alone would be a one-keystroke exit from the whole contract.
GOAL="$(new_goal)"
cat >"$GOAL/ACs.md" <<'ACSEOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] The staging smoke test runs green — `scripts/smoke.sh`
ACSEOF
gate_run "$GOAL" '{"session_id":"partial4"}'
assert_refuses "partial/a-reasonless-blocker-does-not-release-the-turn"
assert_no_record "partial/a-reasonless-blocker-writes-no-record" "$GOAL"
case "$RUN_ERR$RUN_OUT" in
*'blocked-without-reason'* | *'states no reason'* | *'no reason'*)
	pass "partial/the-refusal-names-the-missing-reason" ;;
*) fail "partial/the-refusal-names-the-missing-reason" "err=[$RUN_ERR] out=[$RUN_OUT]" ;;
esac

# A declared whole-loop LOOP_BLOCKED still OUTRANKS a partial: it is a statement
# about the run, where partial is a statement about what is left in it.
GOAL="$(new_goal)"
write_partial "$GOAL"
printf 'the whole engagement is suspended\n' >"$GOAL/.goal-gate/partial5.LOOP_BLOCKED"
gate_run "$GOAL" '{"session_id":"partial5"}'
assert_terminal_non_completion "partial/loop-blocked-outranks-partial"
assert_equals "partial/loop-blocked-wins-the-decision" \
	"loop_blocked" "$(state_field "$GOAL" decision)"

# T3.2: the ORDINARY refusal — not only the stall message — tells the agent how
# to declare a criterion blocked, and what it costs.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"instruct1"}'
assert_refuses "partial/precondition-an-ordinary-unmet-refusal"
for needle in 'mark it blocked' 'blocked:' 'does NOT pass'; do
	case "$RUN_OUT$RUN_ERR" in
	*"$needle"*) pass "partial/ordinary-refusal-mentions [$needle]" ;;
	*) fail "partial/ordinary-refusal-mentions [$needle]" "out=[$RUN_OUT] err=[$RUN_ERR]" ;;
	esac
done
# It must NOT read as an invitation: the criterion has to be one that genuinely
# cannot be met.
case "$RUN_OUT$RUN_ERR" in
*'GENUINELY cannot be met'*) pass "partial/ordinary-refusal-is-not-an-invitation" ;;
*) fail "partial/ordinary-refusal-is-not-an-invitation" "out=[$RUN_OUT]" ;;
esac
# With nothing blocked the count is not mentioned at all — ", 0 blocked" on
# every refusal is noise that invites reading zero as a shortfall.
case "$RUN_OUT$RUN_ERR" in
*'0 blocked'*) fail "partial/ordinary-refusal-omits-a-zero-blocked-count" "out=[$RUN_OUT]" ;;
*) pass "partial/ordinary-refusal-omits-a-zero-blocked-count" ;;
esac

# The three copies of the terminal-status set MUST agree. A copy has drifted
# before, and a drifted set means a partially-ended loop reads as a live
# competitor in one script and as history in another.
ts_stop="$(sed -n 's/^GG_TERMINAL_STATUSES="\(.*\)"$/\1/p' "${TEST_DIR}/../goal-gate-stop.sh" | head -1)"
ts_cancel="$(sed -n 's/^GG_TERMINAL_STATUSES="\(.*\)"$/\1/p' "${TEST_DIR}/../cancel.sh" | head -1)"
ts_pursue="$(sed -n 's/^PG_TERMINAL_STATUSES="\(.*\)"$/\1/p' "${TEST_DIR}/../pursue-goal.sh" | head -1)"
assert_equals "partial/terminal-statuses-agree-stop-vs-cancel" "$ts_stop" "$ts_cancel"
assert_equals "partial/terminal-statuses-agree-stop-vs-pursue" "$ts_stop" "$ts_pursue"
case " $ts_stop " in
*' LOOP_PARTIAL '*) pass "partial/terminal-statuses-include-the-new-ending" ;;
*) fail "partial/terminal-statuses-include-the-new-ending" "got [$ts_stop]" ;;
esac

# ===========================================================================
printf -- '-- 11. Decision trail: every outcome is reconstructable (S38/S39) --\n'
# ===========================================================================

GOAL="$(new_goal)"
write_one_unmet "$GOAL"
gate_run "$GOAL" '{"session_id":"trail1"}'
assert_refuses "trail/precondition-an-unmet-checklist-refuses"

case "$(state_field "$GOAL" acs_path)" in
*/ACs.md) pass "trail/the-evaluated-file-is-recorded" ;;
*) fail "trail/the-evaluated-file-is-recorded" "got [$(state_field "$GOAL" acs_path)]" ;;
esac
assert_equals "trail/the-parser-exit-code-is-recorded" "1" "$(state_field "$GOAL" acs_parse_rc)"
assert_equals "trail/the-validator-exit-code-is-recorded" "1" "$(state_field "$GOAL" acs_validate_rc)"
assert_equals "trail/the-total-is-recorded" "3" "$(state_field "$GOAL" acs_total)"
assert_equals "trail/the-unevidenced-tick-count-is-recorded" "0" "$(state_field "$GOAL" acs_ticked_without_evidence)"

TRAIL="$(state_field "$GOAL" criteria_trail)"
case "$TRAIL" in
*'state=checked'*) pass "trail/per-criterion-checked-state-is-recorded" ;;
*) fail "trail/per-criterion-checked-state-is-recorded" "trail=[$TRAIL]" ;;
esac
case "$TRAIL" in
*'state=unchecked'*) pass "trail/per-criterion-unchecked-state-is-recorded" ;;
*) fail "trail/per-criterion-unchecked-state-is-recorded" "trail=[$TRAIL]" ;;
esac
case "$TRAIL" in
*'evidence=substantive'*) pass "trail/per-criterion-evidence-state-is-recorded" ;;
*) fail "trail/per-criterion-evidence-state-is-recorded" "trail=[$TRAIL]" ;;
esac
if [ "$(printf '%s\n' "$TRAIL" | grep -c '^criterion ')" -eq 3 ]; then
	pass "trail/one-trail-line-per-criterion"
else
	fail "trail/one-trail-line-per-criterion" "trail=[$TRAIL]"
fi

# The trail survives a multi-line value intact through loop-state.sh — a trail
# flattened to one line would not be reconstructable per criterion.
if [ "$(printf '%s\n' "$TRAIL" | wc -l | tr -d ' ')" -ge 3 ]; then
	pass "trail/the-trail-round-trips-as-multiple-lines"
else
	fail "trail/the-trail-round-trips-as-multiple-lines" "trail=[$TRAIL]"
fi

# Even the not-run paths leave a trail saying so.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"trail2"}' "GOAL_GATE_PARSE_ACS=$WORK_DIR/does-not-exist.sh"
assert_refuses "trail/precondition-an-absent-parser-refuses"
assert_equals "trail/a-not-run-evaluation-records-not-run-counts" \
	"<not-run>" "$(state_field "$GOAL" acs_total)"
assert_equals "trail/a-not-run-evaluation-records-not-run-verdict" \
	"<not-run>" "$(state_field "$GOAL" acs_verdict)"

# ===========================================================================
printf -- '-- 12. The ACs.md binding ------------------------------------------\n'
# ===========================================================================

# The gate reads the folder's own ACs.md by the layout contract.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"bind1"}'
assert_permits "binding/the-folder-layout-default-is-used"
assert_equals "binding/the-default-path-is-the-folders-own-acs" \
	"$GOAL/ACs.md" "$(state_field "$GOAL" acs_path)"

# `pursue-goal` binds an explicit path through the loop file; the gate honours
# it and evaluates THAT file.
GOAL="$(new_goal)"
write_one_unmet "$GOAL"
acs_alt="$GOAL/alternate.md"
cat >"$acs_alt" <<'EOF'
- [x] The bound file is the one evaluated — `.claude/skills/goal-gate/parse-acs.sh`
      - evidence: `bash tests/test-parse-acs.sh` reported 160/160 PASS (exit 0)
EOF
gate_run "$GOAL" '{"session_id":"bind2"}'
assert_refuses "binding/precondition-the-default-file-is-unmet"
LF="$(loop_file "$GOAL")"
bash "$LOOP_STATE" set "$LF" acs_path "$acs_alt" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"bind2"}'
assert_permits "binding/an-explicitly-bound-criteria-file-is-the-one-evaluated"
assert_equals "binding/the-bound-path-is-recorded" "$acs_alt" "$(state_field "$GOAL" acs_path)"

# A bound path that does not exist is a refusal, not a fallback to some other
# file that might happen to be complete.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"bind3"}'
assert_permits "binding/precondition-the-default-file-permits"
rm -f "$GOAL/.goal-gate/completion-record.md"
LF="$(loop_file "$GOAL")"
bash "$LOOP_STATE" set "$LF" acs_path "$GOAL/nowhere.md" >/dev/null 2>&1
gate_run "$GOAL" '{"session_id":"bind3"}'
assert_refuses "binding/a-bound-path-that-does-not-exist-refuses"
assert_no_record "binding/a-missing-bound-path-writes-no-record" "$GOAL"

# ===========================================================================
printf -- '-- 13. Discipline: no outcome is silent, no refusal is malformed ---\n'
# ===========================================================================

# Every refusing fixture must emit a parseable decision AND a diagnostic. Run
# them as one sweep so a new refusal path cannot be added without meeting both.
sweep_ok=1
sweep_note=""
for body in \
	'nothing here' \
	'- [~] weird state — `x`' \
	'- [x] no evidence — `.claude/skills/goal-gate/x.sh`' \
	'- [ ] unmet — `.claude/skills/goal-gate/x.sh`'; do
	GOAL="$(new_goal)"
	printf '%s\n' "$body" >"$GOAL/ACs.md"
	gate_run "$GOAL" '{"session_id":"sweep"}'
	if [ "$RUN_STATUS" -ne 0 ]; then
		sweep_ok=0
		sweep_note="[$body] exited $RUN_STATUS"
		break
	fi
	if ! printf '%s' "$RUN_OUT" | jq -e '.decision == "block" and (.reason | length > 0)' >/dev/null 2>&1; then
		sweep_ok=0
		sweep_note="[$body] produced a malformed decision: [$RUN_OUT]"
		break
	fi
	case "$RUN_ERR" in
	*goal-gate:*) : ;;
	*)
		sweep_ok=0
		sweep_note="[$body] refused silently"
		break
		;;
	esac
	if [ -e "$GOAL/.goal-gate/completion-record.md" ]; then
		sweep_ok=0
		sweep_note="[$body] wrote a completion record on a refusal"
		break
	fi
done
if [ "$sweep_ok" -eq 1 ]; then
	pass "discipline/every-refusal-is-loud-parseable-and-records-nothing"
else
	fail "discipline/every-refusal-is-loud-parseable-and-records-nothing" "$sweep_note"
fi

# A permit is repeatable: the second turn on a finished workstream permits
# again rather than flapping into a refusal.
GOAL="$(new_goal)"
write_all_met "$GOAL"
gate_run "$GOAL" '{"session_id":"repeat"}'
assert_permits "discipline/first-turn-on-a-finished-workstream-permits"
gate_run "$GOAL" '{"session_id":"repeat"}'
assert_permits "discipline/a-permit-is-repeatable-not-a-one-shot"
assert_equals "discipline/the-iteration-counter-still-advances" "2" "$(state_field "$GOAL" iteration)"

# The completion record is a claim about a specific evaluation, so it must be
# REWRITTEN, not appended to, when the workstream is evaluated again.
if [ "$(grep -c '^# Goal-gate completion record' "$GOAL/.goal-gate/completion-record.md")" -eq 1 ]; then
	pass "discipline/the-completion-record-is-replaced-not-appended"
else
	fail "discipline/the-completion-record-is-replaced-not-appended" "the record accumulated"
fi

# Regressing a finished workstream must withdraw the permit.
printf -- '- [ ] A newly discovered criterion — `.claude/skills/goal-gate/z.sh`\n      - explanation: found during review\n' >>"$GOAL/ACs.md"
gate_run "$GOAL" '{"session_id":"repeat"}'
assert_refuses "discipline/adding-an-unmet-criterion-withdraws-the-permit"
assert_equals "discipline/the-withdrawal-is-recorded" "refused_unmet" "$(state_field "$GOAL" decision)"

# ===========================================================================
printf '\n== %d passed, %d failed ==\n' "$PASS_COUNT" "$FAIL_COUNT"
# ===========================================================================

[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
