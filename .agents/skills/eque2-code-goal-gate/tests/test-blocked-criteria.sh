#!/usr/bin/env bash
# test-blocked-criteria.sh — the END-TO-END suite for the blocked-criteria
# feature (T4.2).
#
# The other suites test the layers: acs-format-check.sh owns lexical
# conformance, parse-acs.sh owns counting and the verdict, validate-acs.sh owns
# enforcement, and test-decision.sh drives the gate. This one exists because a
# feature can pass every layer and still not work: what a user does is author a
# checklist, end a turn, and look at what came back. So every test here goes
# through the REAL hook, from an authored `ACs.md` to the decision on stdout and
# the files on disk.
#
# THE DEFECT BEING CLOSED, stated once: a criterion that can never be met used
# to hold a loop open for ever, and the only way out was for an operator to
# notice. Blocking gives that criterion an honest name; LOOP_PARTIAL gives the
# loop an honest ending; and neither is a pass.
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). One PASS/FAIL line per test; exits non-zero on any FAIL.

# shellcheck disable=SC2016
# Backticks in fixture text are LITERAL ACs.md markup (a criterion must name its
# specified system in backticks), never command substitution.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_STOP:-${TEST_DIR}/../goal-gate-stop.sh}"
CANCEL="${TEST_DIR}/../cancel.sh"

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

if [ ! -f "$GATE" ]; then
	printf 'FAIL  gate-present\n        no gate at %s\n' "$GATE"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "gate-present"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blocked-criteria-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"
WS_BASE_MISSES="$ROOT/.ws-base-misses"
: >"$WS_BASE_MISSES"

# new_goal — a goal folder with its own gate directory, and a loop file already
# bound to it. Mirrors what pursue-goal.sh writes, so the gate has something to
# claim without the starter's registration checks getting in the way.
#
# mktemp, NOT a counter: this is called in a `$(...)` substitution, so a counter
# would increment in the SUBSHELL and every section would silently share one
# goal folder — state from an earlier test leaking into a later one and quietly
# changing what it proves.
new_goal() {
	local g
	g="$(mktemp -d "$ROOT/goalXXXXXX")" || return 1
	mkdir -p "$g/.goal-gate"
	printf '# goal\n\nContract: [`./ACs.md`](./ACs.md).\n' >"$g/goal.md"
	printf '%s' "$g"
}

# bind <goal> <workstream> — an unclaimed loop file the gate will pick up.
#
# `workstream_token` is written because `pursue-goal` writes it: it is the JOIN
# KEY that survives the renames the gate performs, and a fixture without it is
# not the file the gate is built to read.
bind() {
	local g="$1" ws="$2"
	printf 'goal_folder=%s\nacs_path=%s\nstatus=active\niteration=0\nworkstream_token=%s\n' \
		"$g" "$g/ACs.md" "${ws#_anon-}" >"$g/.goal-gate/$ws.state"
}

# ws_base <goal> <token> — the CURRENT base of the workstream born under
# <token>, whatever the gate has since renamed it to.
#
# The gate renames a workstream when it is claimed (`_ws-<owner>`) and again
# when it ends (`_ended-<owner>-<token>`), so a fixed name written into an
# assertion goes stale the moment the loop it names does anything. Resolving
# through the `workstream_token` FIELD is the only lookup that holds across all
# three namespaces — and it is what the field is for.
#
# NO MATCH IS A FAILURE, AND IT SAYS SO. It used to return 0 with empty output,
# and an empty base is not inert here: `"$G/.goal-gate/$(ws_base …).LOOP_BLOCKED"`
# becomes a HIDDEN `.LOOP_BLOCKED` keyed to nobody, which the gate correctly
# ignores — so the section that wrote it went on to fail for a reason that had
# nothing to do with what it was testing, and a section that only READ a field
# quietly compared the empty string against its expectation. So a miss is
# recorded in a sentinel file that section 9 asserts is empty, and the marker it
# prints names the token it could not resolve.
ws_base() {
	local p b t
	for p in "$1"/.goal-gate/*.state; do
		[ -f "$p" ] || continue
		t="$(sed -n 's/^workstream_token=//p' "$p" 2>/dev/null | tail -1)"
		[ "$t" = "$2" ] || continue
		b="${p##*/}"
		printf '%s' "${b%.state}"
		return 0
	done
	# Recorded through the filesystem, not a counter: every call site is a
	# command substitution, so a variable incremented here dies with its subshell.
	printf 'no workstream carrying workstream_token=%s in %s/.goal-gate\n' \
		"$2" "$1" >>"$WS_BASE_MISSES" 2>/dev/null || true
	printf '<NO-WORKSTREAM-FOR-TOKEN-%s>' "$2"
	return 1
}

# gate_run <goal> <session-id> — the REAL hook, as the host invokes it.
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
gate_run() {
	local g="$1" sid="$2" errfile
	errfile="$(mktemp "${TMPDIR:-/tmp}/bc-err.XXXXXX")"
	RUN_OUT="$(printf '{"session_id":"%s"}' "$sid" |
		GOAL_GATE_DIR="$g/.goal-gate" bash "$GATE" 2>"$errfile")"
	RUN_STATUS=$?
	RUN_ERR="$(cat -- "$errfile")"
	rm -f -- "$errfile"
}

state_field() {
	local g="$1" ws="$2" key="$3"
	sed -n "s/^${key}=//p" "$g/.goal-gate/$ws.state" 2>/dev/null | tail -1
}

# A completion record is the one artefact that must NEVER appear on any path
# through this feature. Asserted by absence, everywhere.
assert_no_record() {
	local name="$1" g="$2" found
	found="$(find "$g" -name '*completion*' -o -name '*COMPLETE*' 2>/dev/null | head -1)"
	if [ -n "$found" ]; then
		fail "$name" "a completion record exists at $found"
	else
		pass "$name"
	fi
}

assert_says() {
	local name="$1" needle="$2"
	case "$RUN_OUT$RUN_ERR" in
	*"$needle"*) pass "$name" ;;
	*) fail "$name" "output did not contain [$needle]: out=[$RUN_OUT] err=[$RUN_ERR]" ;;
	esac
}

assert_lacks() {
	local name="$1" needle="$2"
	case "$RUN_OUT$RUN_ERR" in
	*"$needle"*) fail "$name" "output unexpectedly contained [$needle]" ;;
	*) pass "$name" ;;
	esac
}

printf '== blocked-criteria end-to-end suite ==\n'
printf 'gate: %s\n\n' "$GATE"

# --------------------------------------------------------------------------
printf -- '-- 1. Happy path: one blocked, the rest met -> LOOP_PARTIAL --\n'
# --------------------------------------------------------------------------

G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] **CRITICAL** The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials this run does not have and cannot mint.
EOF
bind "$G" "_anon-e2e1"
gate_run "$G" "e2e1"
assert_says "e2e/the-ending-is-named" "LOOP_PARTIAL"
assert_says "e2e/it-says-plainly-it-is-not-a-pass" "NOT a pass"
assert_says "e2e/the-blocked-criterion-is-named" "The staging smoke test runs green"
assert_says "e2e/its-reason-is-given" "needs production credentials"
assert_says "e2e/a-blocked-critical-is-distinguished" "CRITICAL:"
assert_equals "e2e/the-status-retires-the-workstream" "LOOP_PARTIAL" \
	"$(state_field "$G" "$(ws_base "$G" e2e1)" status)"
assert_equals "e2e/the-decision-is-recorded" "loop_partial" \
	"$(state_field "$G" "$(ws_base "$G" e2e1)" decision)"
assert_no_record "e2e/no-completion-record-is-written" "$G"
# The met count must be exactly what was actually met — blocking must never
# inflate it, which is the one way this feature could become a pass.
assert_equals "e2e/nothing-is-marked-met-on-the-blocker's-account" "1" \
	"$(state_field "$G" "$(ws_base "$G" e2e1)" acs_checked)"
assert_equals "e2e/the-blocked-count-is-recorded" "1" \
	"$(state_field "$G" "$(ws_base "$G" e2e1)" acs_blocked)"

# The run log carries it too — "what was blocked and why" has to survive the
# loop it belonged to.
if [ -f "$G/run-log.jsonl" ]; then
	case "$(cat "$G/run-log.jsonl")" in
	*'"blocked":1'*) pass "e2e/the-run-log-records-the-blocked-count" ;;
	*) fail "e2e/the-run-log-records-the-blocked-count" "$(cat "$G/run-log.jsonl")" ;;
	esac
	case "$(cat "$G/run-log.jsonl")" in
	*'production credentials'*) pass "e2e/the-run-log-records-the-reason" ;;
	*) fail "e2e/the-run-log-records-the-reason" "$(cat "$G/run-log.jsonl")" ;;
	esac
else
	fail "e2e/the-run-log-records-the-blocked-count" "no run log at $G/run-log.jsonl"
	fail "e2e/the-run-log-records-the-reason" "no run log at $G/run-log.jsonl"
fi

# The operator surface, AFTER the ending — which is when anyone asks.
CANCEL_OUT="$(GOAL_GATE_DIR="$G/.goal-gate" bash "$CANCEL" status 2>&1)"
case "$CANCEL_OUT" in
*'1 BLOCKED'*) pass "e2e/cancel-status-reports-the-blocked-count" ;;
*) fail "e2e/cancel-status-reports-the-blocked-count" "[$CANCEL_OUT]" ;;
esac
case "$CANCEL_OUT" in
*'needs production credentials'*) pass "e2e/cancel-status-names-the-reason" ;;
*) fail "e2e/cancel-status-names-the-reason" "[$CANCEL_OUT]" ;;
esac

# State transition: a later turn stands down; the ending is not re-announced.
gate_run "$G" "e2e1"
assert_says "e2e/a-later-turn-stands-down" "already reached a reported END"
assert_no_record "e2e/a-later-turn-still-writes-no-record" "$G"

# --------------------------------------------------------------------------
printf -- '-- 2. One blocked among many outstanding -> still refused --\n'
# --------------------------------------------------------------------------
#
# The single most dangerous way this feature could fail: releasing a turn that
# still has real work in it. Outstanding OUTRANKS blocked, always.

G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
- [ ] The report is written — `scripts/report.sh`
      - explanation: not started.
- [ ] The docs are updated — `docs/index.md`
      - explanation: not started.
EOF
bind "$G" "_anon-e2e2"
gate_run "$G" "e2e2"
assert_says "outstanding/the-turn-is-still-refused" "completion is not established"
assert_lacks "outstanding/it-does-not-end-as-partial" "LOOP_PARTIAL"
assert_no_record "outstanding/no-record-is-written" "$G"
# The outstanding count EXCLUDES the blocked one: 2, not 3.
assert_equals "outstanding/the-count-excludes-the-blocked-criterion" "2" \
	"$(state_field "$G" "$(ws_base "$G" e2e2)" acs_unchecked)"
assert_equals "outstanding/the-blocked-one-is-counted-separately" "1" \
	"$(state_field "$G" "$(ws_base "$G" e2e2)" acs_blocked)"

# --------------------------------------------------------------------------
printf -- '-- 3. Negative: a reasonless blocker releases nothing --\n'
# --------------------------------------------------------------------------
#
# Without this, `[!]` alone is a one-keystroke exit from the entire contract.

G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [x] The parser refuses zero criteria — `scripts/parse.sh`
      - evidence: `bash scripts/parse.sh empty.md` → exit 2
- [!] The staging smoke test runs green — `scripts/smoke.sh`
EOF
bind "$G" "_anon-e2e3"
gate_run "$G" "e2e3"
assert_lacks "reasonless/does-not-end-the-loop" "LOOP_PARTIAL"
assert_says "reasonless/the-refusal-names-the-missing-reason" "reason"
assert_no_record "reasonless/no-record-is-written" "$G"

# --------------------------------------------------------------------------
printf -- '-- 4. Boundary: ALL blocked is not a pass --\n'
# --------------------------------------------------------------------------

G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [!] The staging smoke test runs green — `scripts/smoke.sh`
      - blocked: needs production credentials.
- [!] The load test completes — `scripts/load.sh`
      - blocked: the load rig is decommissioned.
EOF
bind "$G" "_anon-e2e4"
gate_run "$G" "e2e4"
assert_says "all-blocked/ends-as-partial" "LOOP_PARTIAL"
assert_no_record "all-blocked/writes-no-completion-record" "$G"
assert_equals "all-blocked/marks-nothing-met" "0" \
	"$(state_field "$G" "$(ws_base "$G" e2e4)" acs_checked)"
assert_says "all-blocked/both-are-named" "the load rig is decommissioned"

# --------------------------------------------------------------------------
printf -- '-- 5. Permissions: one workstream blocked, the other unaffected --\n'
# --------------------------------------------------------------------------

G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [ ] The report is written — `scripts/report.sh`
      - explanation: not started.
EOF
bind "$G" "_anon-wsA"
bind "$G" "_anon-wsB"
gate_run "$G" "wsA"
gate_run "$G" "wsB"
# The blocker is KEYED to the workstream's CURRENT name. Both loops have been
# claimed by now, so both have been renamed to `_ws-<owner>`, and a signal
# written against the birth name would key nothing — the gate would go on
# evaluating A normally and this whole section would prove the opposite of what
# it says. Resolved through the token rather than assumed.
printf 'A is waiting on an external vendor\n' >"$G/.goal-gate/$(ws_base "$G" wsA).LOOP_BLOCKED"
gate_run "$G" "wsA"
assert_says "isolation/blocking-A-ends-A" "LOOP_BLOCKED"
gate_run "$G" "wsB"
assert_says "isolation/B-is-evaluated-normally" "completion is not established"
assert_lacks "isolation/B-is-not-ended-by-As-blocker" "external vendor"
assert_no_record "isolation/B-gets-no-record" "$G"

# --------------------------------------------------------------------------
printf -- '-- 5a. The keyed blocker MOVES with the workstream it names --\n'
# --------------------------------------------------------------------------
#
# A blocker raised against the UNCLAIMED name must survive the claim that
# renames the loop. It is the only file besides the state file that is keyed to
# a workstream, so a rename that moved one and not the other would silently
# un-declare a blocker that is still in force — the loop would go on being
# evaluated as if nobody had said anything.
#
# THIS IS THE CASE THAT CATCHES THE THREE-LINE MOVE GOING MISSING. Every other
# fixture in this suite writes its blocker after the claim, so deleting the move
# from gg_rename_workstream leaves them all green.
G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [ ] The report is written — `scripts/report.sh`
      - explanation: not started.
EOF
bind "$G" "_anon-mover"
printf 'the vendor has not shipped the credentials\n' >"$G/.goal-gate/_anon-mover.LOOP_BLOCKED"
gate_run "$G" "mover-session"
assert_says "moved-blocker/a-blocker-raised-before-the-claim-is-still-honoured" "LOOP_BLOCKED"
assert_says "moved-blocker/its-reason-is-reported" "the vendor has not shipped"
MOVER_BASE="$(ws_base "$G" mover)"
if [ -f "$G/.goal-gate/$MOVER_BASE.LOOP_BLOCKED" ]; then
	pass "moved-blocker/it-sits-beside-the-renamed-state-file"
else
	fail "moved-blocker/it-sits-beside-the-renamed-state-file" \
		"expected $MOVER_BASE.LOOP_BLOCKED; the gate directory holds: $(ls "$G/.goal-gate")"
fi
if [ -e "$G/.goal-gate/_anon-mover.LOOP_BLOCKED" ]; then
	fail "moved-blocker/nothing-is-left-behind-under-the-old-key" \
		"_anon-mover.LOOP_BLOCKED is still there, so the blocker is keyed twice"
else
	pass "moved-blocker/nothing-is-left-behind-under-the-old-key"
fi
assert_no_record "moved-blocker/no-completion-record-is-written" "$G"

# A bare unkeyed signal binds nobody.
G="$(new_goal)"
cat >"$G/ACs.md" <<'EOF'
- [ ] The report is written — `scripts/report.sh`
      - explanation: not started.
EOF
bind "$G" "_anon-e2e5"
printf 'a blocker from an older version\n' >"$G/.goal-gate/LOOP_BLOCKED"
gate_run "$G" "e2e5"
assert_says "legacy/the-bare-signal-is-reported" "NOT honoured"
assert_says "legacy/the-correction-is-given" "LOOP_BLOCKED"
assert_says "legacy/normal-evaluation-continues" "completion is not established"
assert_no_record "legacy/no-record-is-written" "$G"

# --------------------------------------------------------------------------
printf -- '-- 6. A bystander stands down silently --\n'
# --------------------------------------------------------------------------
#
# A conversation with no goal, in a repository where another session HAS
# declared a blocker, must write nothing and say nothing about it.

G="$(new_goal)"
rm -f "$G/ACs.md" 2>/dev/null
bind "$G" "_anon-owner"
# The owner must CLAIM its workstream first, or the "bystander" simply picks up
# an unclaimed loop and is not a bystander at all.
printf -- '- [ ] The report is written — `scripts/report.sh`\n      - explanation: not started.\n' >"$G/ACs.md"
gate_run "$G" "owner-session"
rm -f "$G/ACs.md" 2>/dev/null
printf 'the owner is blocked on a vendor\n' >"$G/.goal-gate/$(ws_base "$G" owner).LOOP_BLOCKED"
gate_run "$G" "bystander-session"
assert_lacks "bystander/says-nothing-about-the-owners-blocker" "vendor"
assert_no_record "bystander/writes-no-completion-record" "$G"

# --------------------------------------------------------------------------
printf -- '-- 7. The first gate: no loop here at all --\n'
# --------------------------------------------------------------------------
#
# Nothing on disk that says a goal is being pursued -> return at once, writing
# nothing. This is the cheap existence test that runs before any binding work.

G="$(new_goal)"
rm -f "$G/ACs.md" 2>/dev/null
gate_run "$G" "nobody"
assert_equals "first-gate/returns-cleanly" "0" "$RUN_STATUS"
assert_says "first-gate/says-no-loop-exists" "no goal loop exists in this tree"
EMPTY="$(find "$G/.goal-gate" -type f 2>/dev/null | wc -l | tr -d ' ')"
assert_equals "first-gate/writes-nothing-at-all" "0" "$EMPTY"

# --------------------------------------------------------------------------
printf -- '-- 8. Discipline: no path here ever emits a completion --\n'
# --------------------------------------------------------------------------
#
# A blanket sweep over every goal folder this suite created. The feature adds a
# new way for a loop to END; if any of them also emitted a permit, the whole
# thing would be a pass with extra steps.
SWEEP_OK=1
for d in "$ROOT"/goal*; do
	[ -d "$d" ] || continue
	if find "$d" -name '*completion*' -o -name '*COMPLETE*' 2>/dev/null | grep -q .; then
		SWEEP_OK=0
	fi
done
assert_equals "discipline/no-completion-record-anywhere-in-this-suite" "1" "$SWEEP_OK"

# Every `ws_base` lookup in this suite resolved a real workstream. A miss is not
# a harmless empty string: it keys a blocker to nobody and compares a field
# against nothing, so the section it happens in fails for the wrong reason — or
# worse, passes. Asserted once, over the whole run.
WS_MISS_COUNT="$(wc -l <"$WS_BASE_MISSES" 2>/dev/null | tr -d ' ')"
case "$WS_MISS_COUNT" in '' | *[!0-9]*) WS_MISS_COUNT=0 ;; esac
if [ "$WS_MISS_COUNT" = "0" ]; then
	pass "discipline/every-workstream-lookup-in-this-suite-resolved"
else
	fail "discipline/every-workstream-lookup-in-this-suite-resolved" \
		"$WS_MISS_COUNT lookup(s) found no workstream: $(tr '\n' '; ' <"$WS_BASE_MISSES")"
fi

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
