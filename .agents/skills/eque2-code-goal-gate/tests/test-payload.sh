#!/usr/bin/env bash
# test-payload.sh — executable conformance suite for goal-gate-stop.sh's payload
# reader, agent detection and identity binding (T2.1).
#
# Covers every required test-case class: happy path, invalid input, empty/null,
# boundary, error propagation, security boundaries, state transitions and
# resource limits.
#
# The property under test throughout is FAIL CLOSED: every unknown, error,
# missing input or unrunnable check must resolve to NOT DONE. Concretely, the
# gate must emit {"decision":"block",...} on stdout and must never emit an empty
# stdout (a non-claim) on any path reached by an error.
#
# It also holds the line against inherited defects in the predecessor hook
# (~/.claude/hooks/the predecessor stop hook):
#
#   D6   the recursion flag re-triggered an unbounded block
#   jq   unguarded — a missing jq silently produced empty fields and ALLOWED
#        the stop, which is the exact failure this gate exists to prevent
#   R1   (review finding) turn_id is per-turn and must never bind a workstream
#
# Plain bash asserts — deliberately NOT bats (bats is not installed and must not
# be introduced). Prints one PASS/FAIL line per test; exits non-zero on any FAIL.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${GOAL_GATE_MODULE:-${TEST_DIR}/../goal-gate-stop.sh}"
LOOP_STATE="${TEST_DIR}/../loop-state.sh"

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

# --------------------------------------------------------------------------
# Harness
# --------------------------------------------------------------------------
#
# RUN_OUT / RUN_ERR / RUN_STATUS are the three observables of the decision
# contract. Nothing in this suite inspects the gate's internals.

RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0

# gate_run <gate-dir-or-empty> <payload> [env assignments...]
#
# Feeds the payload on stdin. An empty gate-dir means "do not set GOAL_GATE_DIR"
# so the upward marker walk is exercised instead.
gate_run() {
	local gate_dir="$1" payload="$2"
	shift 2
	local errf outf
	errf="$WORK_DIR/err.$$"
	outf="$WORK_DIR/out.$$"

	if [ -n "$gate_dir" ]; then
		set -- "GOAL_GATE_DIR=$gate_dir" "$@"
	fi

	printf '%s' "$payload" |
		env "$@" bash "$GATE" >"$outf" 2>"$errf"
	RUN_STATUS=$?
	RUN_OUT="$(cat "$outf")"
	RUN_ERR="$(cat "$errf")"
	rm -f -- "$outf" "$errf"
}

# gate_run_file <gate-dir> <payload-file> — for payloads too large to hold in a
# shell variable comfortably.
gate_run_file() {
	local gate_dir="$1" file="$2"
	local errf outf
	errf="$WORK_DIR/err.$$"
	outf="$WORK_DIR/out.$$"
	env "GOAL_GATE_DIR=$gate_dir" bash "$GATE" <"$file" >"$outf" 2>"$errf"
	RUN_STATUS=$?
	RUN_OUT="$(cat "$outf")"
	RUN_ERR="$(cat "$errf")"
	rm -f -- "$outf" "$errf"
}

# assert_blocks <name> — the last run REFUSED: exit 0, a block decision on
# stdout, and a goal-gate diagnostic on stderr.
assert_blocks() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0 (hook contract), got $RUN_STATUS ([$RUN_ERR])"
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
		fail "$name" "blocked but emitted no 'goal-gate:' diagnostic"
		return 1
		;;
	esac
	pass "$name"
	return 0
}

# assert_no_claim <name> — the gate stood down: exit 0 and EMPTY stdout. Only
# legitimate for "nothing is being guarded" and the recursion bound.
assert_no_claim() {
	local name="$1"
	if [ "$RUN_STATUS" -ne 0 ]; then
		fail "$name" "expected exit 0, got $RUN_STATUS ([$RUN_ERR])"
		return 1
	fi
	# A stand-down is the absence of a `decision`, not the absence of bytes: only
	# a decision can hold a turn, and the gate now attaches a user-visible
	# `systemMessage` to the endings it allows so that a loop never dies in
	# silence. A systemMessage claims nothing and holds nothing.
	case "$RUN_OUT" in
	*'"decision"'*)
		fail "$name" "expected no decision on stdout, got [$RUN_OUT]"
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
	*) fail "$name" "reason did not mention '$needle': [$RUN_OUT]" ;;
	esac
}

# assert_valid_json_decision <name> — the decision must be parseable JSON with
# the exact contract keys, or neither agent will act on it.
assert_valid_json_decision() {
	local name="$1" decision reason
	if ! decision="$(printf '%s' "$RUN_OUT" | jq -r '.decision' 2>/dev/null)"; then
		fail "$name" "stdout is not valid JSON: [$RUN_OUT]"
		return
	fi
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

# state_field <loop-file> <field> — empty when absent.
state_field() {
	bash "$LOOP_STATE" get "$1" "$2" 2>/dev/null || printf ''
}

# only_state_file <dir> — path of the single .state file, or a marker string.
only_state_file() {
	local n
	n="$(find "$1" -maxdepth 1 -name '*.state' | wc -l | tr -d ' ')"
	if [ "$n" != "1" ]; then
		printf '<%s state files>' "$n"
		return
	fi
	find "$1" -maxdepth 1 -name '*.state'
}

# fresh_gate — a brand-new, empty gate directory.
#
# Uniqueness comes from mktemp, NOT from a counter. Every call site is
# `G="$(fresh_gate)"`, i.e. a command substitution, which runs in a SUBSHELL: a
# `GATE_SEQ=$((GATE_SEQ + 1))` here would be discarded on return, every call
# would hand back the same directory, and state files would pile up in it. The
# assertions that a rejected request leaves NO loop file would then be measuring
# the residue of earlier tests instead of the request under test.
#
# THE FIXTURE MUST CARRY AN ACCEPTANCE CHECKLIST, or this suite measures the
# wrong thing. Since v0.50.0 the gate is PASSIVE when no goal is being pursued
# where it stands: a conversation that claimed no `_anon-*` workstream and has no
# `ACs.md` beside the gate directory stands down silently rather than refusing.
# That was a deliberate change, and it left every payload test here asserting the
# behaviour it replaced — 80 of them, red from that release onwards, so payload
# handling (this suite's actual subject: identity binding, agent detection, the
# derived key, hostile fields) went unmonitored.
#
# One unmet criterion is the minimum that makes the gate engage, so a payload
# that binds correctly reaches a REFUSAL and the assertions mean what they say.
fresh_gate() {
	local base
	base="$(mktemp -d "$ROOT/gate.XXXXXX")" || return 1
	mkdir -p "$base/$MARKER"
	cat >"$base/ACs.md" <<'ACSEOF'
# Done when

- [ ] **CRITICAL** The payload fixture engages the gate - `goal-gate-stop.sh`
  - explanation: deliberately outstanding, so the gate has something to refuse
ACSEOF
	printf '%s' "$base/$MARKER"
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

if [ ! -f "$GATE" ]; then
	printf 'FAIL  gate-present\n        no goal-gate-stop.sh at %s\n' "$GATE"
	printf '\n0 passed, 1 failed\n'
	exit 1
fi
pass "gate-present"

if [ ! -f "$LOOP_STATE" ]; then
	printf 'FAIL  loop-state-present\n        no loop-state.sh at %s\n' "$LOOP_STATE"
	printf '\n%d passed, 1 failed\n' "$PASS_COUNT"
	exit 1
fi
pass "loop-state-present"

if ! command -v jq >/dev/null 2>&1; then
	printf 'FAIL  jq-available\n        jq is required to RUN this suite\n'
	printf '\n%d passed, 1 failed\n' "$PASS_COUNT"
	exit 1
fi
pass "jq-available"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goal-gate-test.XXXXXX")"
ROOT="$(cd -- "$WORK_DIR" && pwd -P)"
MARKER=".goal-gate"

# Canonical payloads.
CLAUDE_PAYLOAD='{"session_id":"2f8c41ae-9b3d-4e77-a1c0-5d6e7f8a9b0c","transcript_path":"/tmp/t.jsonl","stop_hook_active":false,"cwd":"'"$ROOT"'"}'
CODEX_PAYLOAD='{"turn_id":"turn-0001","last_assistant_message":"I have finished the task."}'

# ==========================================================================
# 1. Happy path — both agent shapes parse and bind
# ==========================================================================

G1="$(fresh_gate)"
gate_run "$G1" "$CLAUDE_PAYLOAD"
assert_blocks "happy/claude-shaped-payload-parses"
assert_valid_json_decision "happy/claude-decision-is-valid-json"

L1="$(only_state_file "$G1")"
assert_equals "happy/claude-binds-on-session-id" \
	"2f8c41ae-9b3d-4e77-a1c0-5d6e7f8a9b0c" "$(state_field "$L1" binding_identity)"
assert_equals "happy/claude-detected-as-claude" "claude" "$(state_field "$L1" agent)"
assert_equals "happy/claude-first-iteration-is-1" "1" "$(state_field "$L1" iteration)"
assert_equals "happy/claude-loop-file-named-for-identity" \
	"$G1/2f8c41ae-9b3d-4e77-a1c0-5d6e7f8a9b0c.state" "$L1"

G2="$(fresh_gate)"
gate_run "$G2" "$CODEX_PAYLOAD"
assert_blocks "happy/codex-shaped-payload-parses"
assert_valid_json_decision "happy/codex-decision-is-valid-json"

L2="$(only_state_file "$G2")"
assert_equals "happy/codex-detected-as-codex" "codex" "$(state_field "$L2" agent)"
assert_equals "happy/codex-first-iteration-is-1" "1" "$(state_field "$L2" iteration)"

CODEX_ID="$(state_field "$L2" binding_identity)"
case "$CODEX_ID" in
derived-*) pass "happy/codex-binds-on-a-derived-key" ;;
*) fail "happy/codex-binds-on-a-derived-key" "identity was [$CODEX_ID]" ;;
esac
assert_equals "happy/codex-records-turn-id-for-diagnostics-only" \
	"turn-0001" "$(state_field "$L2" last_turn_id)"

# The derived key must be hex-only, so it can never carry a separator.
case "${CODEX_ID#derived-}" in
*[!0-9a-f]*) fail "happy/derived-key-is-hex-only" "got [$CODEX_ID]" ;;
*) pass "happy/derived-key-is-hex-only" ;;
esac
assert_equals "happy/derived-key-length-is-fixed" "40" "${#CODEX_ID}"

# Neither agent's payload may be REQUIRED to carry the other's fields.
G3="$(fresh_gate)"
gate_run "$G3" '{"session_id":"sess-no-cwd-at-all"}'
assert_blocks "portability/claude-payload-without-cwd-still-binds"
assert_equals "portability/claude-without-cwd-binds-on-session" \
	"sess-no-cwd-at-all" "$(state_field "$(only_state_file "$G3")" binding_identity)"

G4="$(fresh_gate)"
gate_run "$G4" '{"turn_id":"t-1"}'
assert_blocks "portability/codex-payload-without-last-message-still-binds"
assert_equals "portability/codex-without-last-message-is-codex" \
	"codex" "$(state_field "$(only_state_file "$G4")" agent)"

# A payload carrying BOTH identities prefers session_id — the stable one.
G5="$(fresh_gate)"
gate_run "$G5" '{"session_id":"sess-both","turn_id":"turn-both"}'
assert_blocks "portability/both-identities-present-parses"
assert_equals "portability/both-identities-prefers-session-id" \
	"sess-both" "$(state_field "$(only_state_file "$G5")" binding_identity)"

# Unknown extra fields must never break parsing — forward compatibility.
G6="$(fresh_gate)"
gate_run "$G6" '{"session_id":"sess-extra","future_field":{"a":[1,2,3]},"another":true}'
assert_blocks "portability/unknown-future-fields-are-ignored"
assert_equals "portability/unknown-fields-do-not-disturb-binding" \
	"sess-extra" "$(state_field "$(only_state_file "$G6")" binding_identity)"

# ==========================================================================
# 2. Invalid input — malformed JSON, empty stdin, not an object
# ==========================================================================

G_INV="$(fresh_gate)"

gate_run "$G_INV" '{"session_id": "unterminated'
assert_blocks "invalid/malformed-json-refuses"
assert_reason_mentions "invalid/malformed-json-says-so" "not valid JSON"

gate_run "$G_INV" '{'
assert_blocks "invalid/lone-brace-refuses"

gate_run "$G_INV" 'this is not json at all'
assert_blocks "invalid/prose-refuses"

gate_run "$G_INV" '{"session_id":"a",}'
assert_blocks "invalid/trailing-comma-refuses"

gate_run "$G_INV" ''
assert_blocks "invalid/empty-stdin-refuses"
assert_reason_mentions "invalid/empty-stdin-says-so" "empty"

gate_run "$G_INV" '   '
assert_blocks "invalid/whitespace-only-stdin-refuses"

gate_run "$G_INV" $'\n\n'
assert_blocks "invalid/newlines-only-stdin-refuses"

# JSON that is valid but is not an object carries no identifiable fields.
gate_run "$G_INV" '[]'
assert_blocks "invalid/empty-array-refuses"
assert_reason_mentions "invalid/array-says-not-an-object" "not an object"

gate_run "$G_INV" '[{"session_id":"a"}]'
assert_blocks "invalid/array-of-objects-refuses"

gate_run "$G_INV" '"just a string"'
assert_blocks "invalid/bare-string-refuses"

gate_run "$G_INV" '42'
assert_blocks "invalid/bare-number-refuses"

gate_run "$G_INV" 'true'
assert_blocks "invalid/bare-boolean-refuses"

gate_run "$G_INV" 'null'
assert_blocks "invalid/bare-null-refuses"

# More than one JSON document on stdin is ambiguous — which one is the request?
gate_run "$G_INV" '{"session_id":"a"} {"session_id":"b"}'
assert_blocks "invalid/two-json-documents-refuse"

# ==========================================================================
# 3. Empty/null — both identity fields absent
# ==========================================================================

gate_run "$G_INV" '{}'
assert_blocks "empty/no-identity-fields-refuses"
assert_reason_mentions "empty/no-identity-says-so" "no usable identity"

gate_run "$G_INV" '{"cwd":"/tmp","stop_hook_active":false}'
assert_blocks "empty/shared-fields-without-identity-refuse"

gate_run "$G_INV" '{"session_id":null,"turn_id":null}'
assert_blocks "empty/both-identities-json-null-refuse"

gate_run "$G_INV" '{"session_id":"","turn_id":""}'
assert_blocks "empty/both-identities-empty-string-refuse"

# The critical one: an absent identity must NEVER be bound to "". A loop file
# named ".state" would collapse every workstream on the machine onto a single
# iteration counter.
if [ -e "$G_INV/.state" ]; then
	fail "empty/never-binds-to-the-empty-string" "a '.state' file was created"
else
	pass "empty/never-binds-to-the-empty-string"
fi
assert_equals "empty/no-loop-file-created-for-an-unidentified-request" \
	"<0 state files>" "$(only_state_file "$G_INV")"

# ==========================================================================
# 4. Invalid input — an identity present but empty, whitespace or null
# ==========================================================================
#
# Each of these must be treated as ABSENT, not bound to "".

G_ID="$(fresh_gate)"

gate_run "$G_ID" '{"session_id":""}'
assert_blocks "identity/empty-session-id-is-absent"

gate_run "$G_ID" '{"session_id":"   "}'
assert_blocks "identity/whitespace-session-id-is-absent"

gate_run "$G_ID" '{"session_id":"\t\n "}'
assert_blocks "identity/tab-newline-session-id-is-absent"

gate_run "$G_ID" '{"session_id":null}'
assert_blocks "identity/null-session-id-is-absent"

gate_run "$G_ID" '{"turn_id":""}'
assert_blocks "identity/empty-turn-id-is-absent"

gate_run "$G_ID" '{"turn_id":"   "}'
assert_blocks "identity/whitespace-turn-id-is-absent"

gate_run "$G_ID" '{"turn_id":null}'
assert_blocks "identity/null-turn-id-is-absent"

# A non-string identity is not an identity either.
gate_run "$G_ID" '{"session_id":12345}'
assert_blocks "identity/numeric-session-id-is-absent"

gate_run "$G_ID" '{"session_id":true}'
assert_blocks "identity/boolean-session-id-is-absent"

gate_run "$G_ID" '{"session_id":{"nested":"object"}}'
assert_blocks "identity/object-session-id-is-absent"

gate_run "$G_ID" '{"session_id":["a"]}'
assert_blocks "identity/array-session-id-is-absent"

# An empty session_id must not suppress a usable turn_id — it is absent, so the
# request is Codex-shaped and binds on the derived key.
G_ID2="$(fresh_gate)"
gate_run "$G_ID2" '{"session_id":"","turn_id":"turn-x"}'
assert_blocks "identity/empty-session-falls-through-to-codex"
assert_equals "identity/empty-session-detected-as-codex" \
	"codex" "$(state_field "$(only_state_file "$G_ID2")" agent)"
case "$(state_field "$(only_state_file "$G_ID2")" binding_identity)" in
derived-*) pass "identity/empty-session-binds-on-derived-key" ;;
*) fail "identity/empty-session-binds-on-derived-key" "not a derived key" ;;
esac

# Nothing above may have created a loop file in the rejection gate.
assert_equals "identity/rejections-create-no-loop-file" \
	"<0 state files>" "$(only_state_file "$G_ID")"

# ==========================================================================
# 5. Security boundaries — an identity may never compose a path
# ==========================================================================
#
# Each of these clears the "usable" test (non-empty, non-whitespace) and would
# be bound by a naive implementation. Every one must be rejected BEFORE a path
# is composed, and must leave no file anywhere.

G_SEC="$(fresh_gate)"
SEC_OUTSIDE="$ROOT/outside-the-gate"
mkdir -p "$SEC_OUTSIDE"

traversal_ok=1
traversal_note=""
# The '$' and backtick fixtures below are LITERAL attack strings, so single
# quotes are exactly right — expanding them here would test the test harness
# rather than the gate.
# shellcheck disable=SC2016
for bad in \
	'../escape' \
	'../../escape' \
	'..' \
	'.' \
	'a/b' \
	'/absolute' \
	'/etc/passwd' \
	'sub/dir/deep' \
	'..\\windows' \
	'a\\b' \
	'./relative' \
	'x/../../../../tmp/x' \
	'name with spaces' \
	'semi;colon' \
	'pipe|char' \
	'dollar$sign' \
	'back`tick`' \
	'star*glob' \
	'question?mark' \
	'tilde~expand' \
	$'new\nline' \
	$'tab\tchar' \
	$'carriage\rreturn'; do
	gate_run "$G_SEC" "$(jq -nc --arg s "$bad" '{session_id:$s}')"
	if [ "$RUN_STATUS" -ne 0 ]; then
		traversal_ok=0
		traversal_note="[$bad] exited $RUN_STATUS"
		break
	fi
	case "$RUN_OUT" in
	*'"decision":"block"'*) : ;;
	*)
		traversal_ok=0
		traversal_note="[$bad] did not block: [$RUN_OUT]"
		break
		;;
	esac
done
if [ "$traversal_ok" -eq 1 ]; then
	pass "security/unsafe-identities-are-all-rejected"
else
	fail "security/unsafe-identities-are-all-rejected" "$traversal_note"
fi

assert_equals "security/traversal-attempts-create-no-loop-file" \
	"<0 state files>" "$(only_state_file "$G_SEC")"

if [ -n "$(find "$SEC_OUTSIDE" -mindepth 1 2>/dev/null)" ]; then
	fail "security/nothing-written-outside-the-gate-directory" "files appeared in $SEC_OUTSIDE"
else
	pass "security/nothing-written-outside-the-gate-directory"
fi

# Nowhere in the whole fixture tree may an 'escape.state' have appeared — the
# traversal fixtures above all tried to write one outside their gate.
if [ -n "$(find "$ROOT" -name 'escape.state' 2>/dev/null)" ]; then
	fail "security/traversal-did-not-escape-the-gate-directory" "an escape.state appeared under $ROOT"
else
	pass "security/traversal-did-not-escape-the-gate-directory"
fi

# A NUL byte inside the identity: bash cannot hold one, so a naive read would
# silently TRUNCATE it — turning "safe\0/../../evil" into "safe". The gate must
# detect the loss and reject rather than bind a truncated identity.
gate_run "$G_SEC" '{"session_id":"aaaa\u0000bbbb"}'
assert_blocks "security/nul-byte-in-identity-is-rejected"
if [ -e "$G_SEC/aaaa.state" ]; then
	fail "security/nul-truncated-identity-never-names-a-file" "aaaa.state was created"
else
	pass "security/nul-truncated-identity-never-names-a-file"
fi

gate_run "$G_SEC" '{"turn_id":"tt\u0000tt","session_id":null}'
assert_blocks "security/nul-byte-in-turn-id-still-refuses-or-derives"

# A NUL-truncated turn_id binds nothing (turn_id is never a key), but it must
# also not be RECORDED as its truncated remains — "tt" is a value that never
# existed on the wire. A diagnostic that quietly lies is worse than one that
# admits it could not be read.
G_SEC2="$(fresh_gate)"
gate_run "$G_SEC2" '{"turn_id":"tt\u0000tt"}'
assert_blocks "security/nul-turn-id-in-a-fresh-gate-blocks"
assert_equals "security/nul-truncated-turn-id-is-not-recorded-as-truncated" \
	"<unreadable>" "$(state_field "$(only_state_file "$G_SEC2")" last_turn_id)"

# An over-long identity must not name a file either.
LONG_ID="$(printf 'a%.0s' $(seq 1 400))"
gate_run "$G_SEC" "$(jq -nc --arg s "$LONG_ID" '{session_id:$s}')"
assert_blocks "security/over-long-identity-is-rejected"

# --- payload strings are NEVER evaluated as shell ---------------------------
#
# Every field is loaded with a command substitution that would create a witness
# file if any value ever reached a shell evaluation context.

WITNESS="$ROOT/PWNED"
rm -f -- "$WITNESS"

G_EVAL="$(fresh_gate)"
EVIL_PAYLOAD="$(jq -nc \
	--arg s 'sess-safe-0001' \
	--arg t "\$(touch $WITNESS)" \
	--arg c "\`touch $WITNESS\`" \
	--arg m "; touch $WITNESS; echo \$(touch $WITNESS) \${IFS}" \
	'{session_id:$s, turn_id:$t, cwd:$c, last_assistant_message:$m, stop_hook_active:false}')"
gate_run "$G_EVAL" "$EVIL_PAYLOAD"
assert_blocks "security/payload-with-shell-metacharacters-parses-safely"

if [ -e "$WITNESS" ]; then
	fail "security/payload-values-are-never-evaluated-as-shell" "$WITNESS was created"
else
	pass "security/payload-values-are-never-evaluated-as-shell"
fi

L_EVAL="$(only_state_file "$G_EVAL")"
assert_equals "security/metacharacter-turn-id-round-trips-as-inert-text" \
	"\$(touch $WITNESS)" "$(state_field "$L_EVAL" last_turn_id)"
assert_equals "security/binding-unaffected-by-hostile-neighbours" \
	"sess-safe-0001" "$(state_field "$L_EVAL" binding_identity)"

# A hostile identity must not be able to inject control characters into the
# reason string the agent reads back.
gate_run "$G_EVAL" '{"session_id":"a\u0007bc"}'
assert_blocks "security/control-characters-in-identity-are-rejected"
assert_valid_json_decision "security/refusal-reason-remains-valid-json"

# A quote/backslash-laden value must not break the JSON decision.
gate_run "$G_EVAL" "$(jq -nc '{session_id:"x\"y\\z"}')"
assert_blocks "security/quote-and-backslash-identity-is-rejected"
assert_valid_json_decision "security/quote-laden-refusal-is-still-valid-json"

# ==========================================================================
# 6. Boundary — the second agent's extra fields present but null
# ==========================================================================

G_NULL="$(fresh_gate)"
gate_run "$G_NULL" '{"turn_id":"turn-nulls","last_assistant_message":null,"session_id":null,"cwd":null,"stop_hook_active":null}'
assert_blocks "boundary/codex-extra-fields-null-parses"
L_NULL="$(only_state_file "$G_NULL")"
assert_equals "boundary/null-extras-still-detect-codex" "codex" "$(state_field "$L_NULL" agent)"
assert_equals "boundary/null-extras-still-count-an-iteration" "1" "$(state_field "$L_NULL" iteration)"
case "$(state_field "$L_NULL" binding_identity)" in
derived-*) pass "boundary/null-extras-still-bind-a-derived-key" ;;
*) fail "boundary/null-extras-still-bind-a-derived-key" "unexpected identity" ;;
esac

# A null last_assistant_message must record no byte count rather than "null".
assert_equals "boundary/null-last-message-records-no-length" \
	"" "$(state_field "$L_NULL" last_message_bytes)"

# An empty (but present) last_assistant_message is a real zero-length message.
G_NULL2="$(fresh_gate)"
gate_run "$G_NULL2" '{"turn_id":"t","last_assistant_message":""}'
assert_blocks "boundary/empty-last-message-parses"
assert_equals "boundary/empty-last-message-records-zero-length" \
	"0" "$(state_field "$(only_state_file "$G_NULL2")" last_message_bytes)"

# stop_hook_active given as a string rather than a boolean must not be trusted
# as the boolean true — an unknown shape may not disable a guard.
G_NULL3="$(fresh_gate)"
gate_run "$G_NULL3" '{"session_id":"s-strflag","stop_hook_active":"true"}'
assert_blocks "boundary/string-stop-hook-active-parses"

# ==========================================================================
# 7. Boundary — three turns, different turn_id, NO session_id (review R1)
# ==========================================================================
#
# THE headline property. turn_id changes every turn. If it were the binding
# key, each invocation would create its own loop file and the iteration counter
# would read 1 forever — a stall could never be detected. All three invocations
# must land on ONE workstream with the counter advancing 1 -> 2 -> 3.

G_R1="$(fresh_gate)"

gate_run "$G_R1" '{"turn_id":"turn-aaaa-1111","last_assistant_message":"first"}'
assert_blocks "r1/turn-1-blocks"
R1_FILE_1="$(only_state_file "$G_R1")"
assert_equals "r1/turn-1-iteration-is-1" "1" "$(state_field "$R1_FILE_1" iteration)"

gate_run "$G_R1" '{"turn_id":"turn-bbbb-2222","last_assistant_message":"second"}'
assert_blocks "r1/turn-2-blocks"
R1_FILE_2="$(only_state_file "$G_R1")"
assert_equals "r1/turn-2-iteration-is-2" "2" "$(state_field "$R1_FILE_2" iteration)"

gate_run "$G_R1" '{"turn_id":"turn-cccc-3333","last_assistant_message":"third"}'
assert_blocks "r1/turn-3-blocks"
R1_FILE_3="$(only_state_file "$G_R1")"
assert_equals "r1/turn-3-iteration-is-3" "3" "$(state_field "$R1_FILE_3" iteration)"

assert_equals "r1/all-three-turns-share-one-loop-file" "$R1_FILE_1" "$R1_FILE_3"
assert_equals "r1/exactly-one-workstream-file-exists" "1" \
	"$(find "$G_R1" -maxdepth 1 -name '*.state' | wc -l | tr -d ' ')"

# The identity must not be, contain, or be derived from any of the turn_ids.
R1_ID="$(state_field "$R1_FILE_3" binding_identity)"
r1_clean=1
for t in turn-aaaa-1111 turn-bbbb-2222 turn-cccc-3333; do
	case "$R1_ID" in
	*"$t"*) r1_clean=0 ;;
	esac
done
if [ "$r1_clean" -eq 1 ]; then
	pass "r1/binding-identity-contains-no-turn-id"
else
	fail "r1/binding-identity-contains-no-turn-id" "identity [$R1_ID] embeds a turn_id"
fi

# Only the LAST turn_id is retained, and purely as a diagnostic.
assert_equals "r1/only-latest-turn-id-is-recorded" \
	"turn-cccc-3333" "$(state_field "$R1_FILE_3" last_turn_id)"

# The derived key must be stable for the same gate directory and DIFFERENT for
# another one — otherwise two workstreams would share a counter.
G_R1B="$(fresh_gate)"
gate_run "$G_R1B" '{"turn_id":"turn-zzzz"}'
assert_blocks "r1/second-workstream-blocks"
R1B_ID="$(state_field "$(only_state_file "$G_R1B")" binding_identity)"
if [ "$R1B_ID" = "$R1_ID" ]; then
	fail "r1/distinct-workstreams-get-distinct-keys" "both derived [$R1_ID]"
else
	pass "r1/distinct-workstreams-get-distinct-keys"
fi
assert_equals "r1/second-workstream-counter-is-independent" \
	"1" "$(state_field "$(only_state_file "$G_R1B")" iteration)"

# A Claude-shaped session binds on session_id across turns just as stably.
G_R1C="$(fresh_gate)"
gate_run "$G_R1C" '{"session_id":"stable-sess","cwd":"'"$ROOT"'"}'
gate_run "$G_R1C" '{"session_id":"stable-sess","cwd":"'"$ROOT"'"}'
gate_run "$G_R1C" '{"session_id":"stable-sess","cwd":"'"$ROOT"'"}'
assert_blocks "r1/claude-third-turn-blocks"
assert_equals "r1/claude-session-counter-reaches-3" \
	"3" "$(state_field "$(only_state_file "$G_R1C")" iteration)"

# Two DIFFERENT sessions in the same gate directory stay separate.
gate_run "$G_R1C" '{"session_id":"other-sess"}'
assert_blocks "r1/second-session-blocks"
assert_equals "r1/two-sessions-produce-two-loop-files" "2" \
	"$(find "$G_R1C" -maxdepth 1 -name '*.state' | wc -l | tr -d ' ')"
assert_equals "r1/original-session-counter-untouched" \
	"3" "$(state_field "$G_R1C/stable-sess.state" iteration)"

# ==========================================================================
# 8. State transitions — the D6 recursion bound
# ==========================================================================
#
# Ancestor defect D6: with the recursion flag already set, the ancestor
# re-blocked without bound and the loop could never be escaped. Here the block
# is bounded, the trip is recorded, and it is NOT reported as a clean finish.

G_D6="$(fresh_gate)"
D6_PAYLOAD='{"session_id":"d6-sess","stop_hook_active":true,"cwd":"'"$ROOT"'"}'

gate_run "$G_D6" "$D6_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=3"
assert_blocks "d6/recursion-flag-set-iteration-1-still-blocks"
gate_run "$G_D6" "$D6_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=3"
assert_blocks "d6/recursion-flag-set-iteration-2-still-blocks"
gate_run "$G_D6" "$D6_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=3"
assert_blocks "d6/recursion-flag-set-iteration-3-still-blocks"
assert_equals "d6/counter-advanced-under-the-recursion-flag" \
	"3" "$(state_field "$G_D6/d6-sess.state" iteration)"

# Past the bound the gate stands down rather than blocking forever.
gate_run "$G_D6" "$D6_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=3"
assert_no_claim "d6/past-the-bound-the-block-stops"
assert_equals "d6/bound-trip-is-recorded-not-silent" \
	"recursion_bound_exceeded" "$(state_field "$G_D6/d6-sess.state" status)"
case "$RUN_ERR" in
*recursion*) pass "d6/bound-trip-is-announced-on-stderr" ;;
*) fail "d6/bound-trip-is-announced-on-stderr" "stderr was [$RUN_ERR]" ;;
esac

# The stand-down must never be phrased as a completion.
case "$RUN_OUT" in
*'"decision"'*) fail "d6/bound-trip-emits-no-decision-at-all" "stdout was [$RUN_OUT]" ;;
*) pass "d6/bound-trip-emits-no-decision-at-all" ;;
esac

# --- the same bound, against an ADOPTABLE workstream ----------------------
#
# THE FIXTURE ABOVE IS SELF-BOUND, AND A SELF-BOUND LOOP IS DELIBERATELY NEVER
# RENAMED — it is in no adoption pool, so there is nothing to hide it from. That
# makes it blind to the half of this ending that matters on a real loop: the
# recursion bound must also RETIRE the workstream, or a loop that tripped the
# bound is left in the pool with a live claim and a fresh heartbeat, looking to
# the next conversation exactly like work to pick up. Deleting the retirement
# from this path left every suite in this project green.
#
# So the same bound is driven again against a `pursue-goal`-shaped `_anon-*`
# file. The birth token is captured from the name BEFORE the first turn and the
# retired name is compared against a literal built from it, never against a name
# read back out of the file under test.
G_D6R="$(fresh_gate)"
bash "$LOOP_STATE" set "$G_D6R/_anon-d6r.state" created_by pursue-goal >/dev/null 2>&1
bash "$LOOP_STATE" set "$G_D6R/_anon-d6r.state" workstream_token d6r >/dev/null 2>&1
D6R_TOKEN=""
for D6R_P in "$G_D6R"/_anon-*.state; do
	[ -f "$D6R_P" ] || continue
	D6R_B="${D6R_P##*/}"
	D6R_B="${D6R_B%.state}"
	D6R_TOKEN="${D6R_B#_anon-}"
	break
done
assert_equals "d6/the-adoptable-fixture-is-born-unclaimed" "d6r" "$D6R_TOKEN"

D6R_PAYLOAD='{"session_id":"d6r-sess","stop_hook_active":true,"cwd":"'"$ROOT"'"}'
gate_run "$G_D6R" "$D6R_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=1"
assert_blocks "d6/the-adoptable-loop-is-claimed-and-governed-first"
assert_equals "d6/claiming-renamed-it-for-its-owner" \
	"1" "$(find "$G_D6R" -maxdepth 1 -name '_ws-d6r-sess.state' | wc -l | tr -d ' ')"

gate_run "$G_D6R" "$D6R_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=1"
assert_no_claim "d6/the-adoptable-loop-stands-down-past-the-bound"
if [ -f "$G_D6R/_ended-d6r-sess-$D6R_TOKEN.state" ]; then
	pass "d6/the-bound-retires-the-workstream-out-of-the-adoptable-pool"
else
	fail "d6/the-bound-retires-the-workstream-out-of-the-adoptable-pool" \
		"expected _ended-d6r-sess-$D6R_TOKEN.state; the directory holds: $(printf '%s ' "$G_D6R"/*)"
fi
D6R_POOL="$(find "$G_D6R" -maxdepth 1 -type f \( -name '_anon-*.state' -o -name '_ws-*.state' \) 2>/dev/null | wc -l | tr -d ' ')"
assert_equals "d6/nothing-is-left-in-the-adoptable-pool-after-the-bound" "0" "$D6R_POOL"
assert_equals "d6/the-retired-file-keeps-the-bound-trip-on-record" \
	"recursion_bound_exceeded" \
	"$(state_field "$G_D6R/_ended-d6r-sess-$D6R_TOKEN.state" status)"

# WITHOUT the recursion flag the bound does not apply — an ordinary loop past
# the bound is stall detection's business (T2.4), not the recursion guard's.
G_D6B="$(fresh_gate)"
NOFLAG_PAYLOAD='{"session_id":"d6b-sess","stop_hook_active":false}'
gate_run "$G_D6B" "$NOFLAG_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=1"
assert_blocks "d6/no-flag-iteration-1-blocks"
gate_run "$G_D6B" "$NOFLAG_PAYLOAD" "GOAL_GATE_MAX_ITERATIONS=1"
assert_blocks "d6/no-flag-past-the-bound-still-blocks"
assert_equals "d6/no-flag-status-not-marked-bound-exceeded" \
	"" "$(state_field "$G_D6B/d6b-sess.state" status)"

# An absent stop_hook_active must behave as false, never as true — an absent
# field may not disable a guard.
G_D6C="$(fresh_gate)"
gate_run "$G_D6C" '{"session_id":"d6c-sess"}' "GOAL_GATE_MAX_ITERATIONS=1"
assert_blocks "d6/absent-flag-iteration-1-blocks"
gate_run "$G_D6C" '{"session_id":"d6c-sess"}' "GOAL_GATE_MAX_ITERATIONS=1"
assert_blocks "d6/absent-flag-past-the-bound-still-blocks"

# A garbage bound falls back to the default rather than disabling the block.
G_D6D="$(fresh_gate)"
gate_run "$G_D6D" '{"session_id":"d6d","stop_hook_active":true}' "GOAL_GATE_MAX_ITERATIONS=not-a-number"
assert_blocks "d6/non-numeric-bound-falls-back-to-the-default"

G_D6E="$(fresh_gate)"
gate_run "$G_D6E" '{"session_id":"d6e","stop_hook_active":true}' "GOAL_GATE_MAX_ITERATIONS="
assert_blocks "d6/empty-bound-falls-back-to-the-default"

# ==========================================================================
# 9. Error propagation — the JSON tool is unavailable
# ==========================================================================
#
# The ancestor had NO such guard: without jq every extraction produced "" and
# the hook exited 0, allowing the stop. This is the single most consequential
# fail-open in the predecessor.

SHIM="$ROOT/shim-bin"
mkdir -p "$SHIM"
for tool in cat tr base64 wc cut dirname mktemp mv rm chmod stat sed awk sleep rmdir mkdir find shasum sha256sum env bash; do
	src="$(command -v "$tool" 2>/dev/null)" || continue
	ln -sf "$src" "$SHIM/$tool" 2>/dev/null || true
done

if [ -e "$SHIM/jq" ]; then
	fail "errprop/shim-excludes-jq" "the shim PATH still contains jq"
else
	pass "errprop/shim-excludes-jq"
fi

G_JQ="$(fresh_gate)"
gate_run "$G_JQ" "$CLAUDE_PAYLOAD" "PATH=$SHIM"
assert_blocks "errprop/missing-jq-refuses"
assert_reason_mentions "errprop/missing-jq-is-reported" "jq"
assert_valid_json_decision "errprop/missing-jq-decision-is-valid-json"

# It must refuse for the Codex shape too — the guard is not agent-specific.
gate_run "$G_JQ" "$CODEX_PAYLOAD" "PATH=$SHIM"
assert_blocks "errprop/missing-jq-refuses-for-codex-shape-too"

# ...and for an empty payload, which without jq is indistinguishable.
gate_run "$G_JQ" '' "PATH=$SHIM"
assert_blocks "errprop/missing-jq-with-empty-payload-refuses"

# An unwritable gate directory cannot record progress, so completion cannot be
# tracked — refuse rather than proceed blind.
G_RO="$(fresh_gate)"
chmod 500 "$G_RO"
gate_run "$G_RO" '{"session_id":"ro-sess"}'
ro_status=$RUN_STATUS
ro_out="$RUN_OUT"
chmod 700 "$G_RO"
if [ "$ro_status" -ne 0 ]; then
	fail "errprop/unwritable-gate-directory-refuses" "exit $ro_status"
else
	case "$ro_out" in
	*'"decision":"block"'*) pass "errprop/unwritable-gate-directory-refuses" ;;
	*) fail "errprop/unwritable-gate-directory-refuses" "stdout was [$ro_out]" ;;
	esac
fi

# A GOAL_GATE_DIR that does not exist means no gate is resolvable there; the
# gate must not invent one, and must not claim completion.
gate_run "$ROOT/no-such-gate-dir" '{"session_id":"ghost"}'
if [ "$RUN_STATUS" -ne 0 ]; then
	fail "errprop/nonexistent-gate-dir-exits-0" "exit $RUN_STATUS"
else
	pass "errprop/nonexistent-gate-dir-exits-0"
fi
if [ -e "$ROOT/no-such-gate-dir" ]; then
	fail "errprop/nonexistent-gate-dir-is-not-created" "the directory was created"
else
	pass "errprop/nonexistent-gate-dir-is-not-created"
fi

# A broken loop-state module is an unrunnable check, not a pass.
G_BAD_LS="$(fresh_gate)"
BAD_LS="$ROOT/broken-loop-state.sh"
printf '#!/usr/bin/env bash\nexit 9\n' >"$BAD_LS"
chmod 755 "$BAD_LS"
gate_run "$G_BAD_LS" '{"session_id":"bad-ls"}' "GOAL_GATE_LOOP_STATE=$BAD_LS"
assert_blocks "errprop/unwritable-loop-state-refuses"

# ==========================================================================
# 10. Gate engagement — the ONLY legitimate non-claim
# ==========================================================================

BARE="$ROOT/bare-tree/deep/deeper"
mkdir -p "$BARE"
gate_run "" "$(jq -nc --arg c "$BARE" '{session_id:"nobody", cwd:$c}')" "HOME=$ROOT/bare-tree"
assert_no_claim "engage/no-marker-anywhere-means-no-claim"
case "$RUN_ERR" in
*"no claim"*) pass "engage/non-claim-is-announced-on-stderr" ;;
*) fail "engage/non-claim-is-announced-on-stderr" "stderr was [$RUN_ERR]" ;;
esac

# STRICTLY the repo root: a marker at the git top level governs a session run
# from a nested sub-directory of THAT repo — git rev-parse resolves the nested
# cwd back to the root where the marker lives.
WALK_ROOT="$ROOT/walk-tree"
mkdir -p "$WALK_ROOT/$MARKER" "$WALK_ROOT/a/b/c"
cat >"$WALK_ROOT/ACs.md" <<'ACSEOF'
# Done when

- [ ] **CRITICAL** The nested walk engages the gate - `goal-gate-stop.sh`
  - explanation: deliberately outstanding
ACSEOF
git -C "$WALK_ROOT" init -q
gate_run "" "$(jq -nc --arg c "$WALK_ROOT/a/b/c" '{session_id:"walker", cwd:$c}')" "HOME=$ROOT"
assert_blocks "engage/marker-at-repo-root-governs-a-nested-cwd"
assert_equals "engage/nested-cwd-binds-in-the-root-gate" \
	"walker" "$(state_field "$WALK_ROOT/$MARKER/walker.state" binding_identity)"

# The ancestor-bleed is CLOSED: a marker on an ancestor that is NOT the repo
# root does not govern. Here the marker sits on a non-repo ancestor and the cwd
# is a separate repo beneath it with no marker of its own — strictly-repo-root
# means no gate governs, so the session stands down instead of adopting a goal
# that belongs to a different tree.
OUTSIDE="$ROOT/outside-tree"
mkdir -p "$OUTSIDE/$MARKER" "$OUTSIDE/child"
git -C "$OUTSIDE/child" init -q
gate_run "" "$(jq -nc --arg c "$OUTSIDE/child" '{session_id:"stranger", cwd:$c}')" "HOME=$ROOT"
assert_no_claim "engage/ancestor-marker-does-not-govern-a-child-repo"

# A cwd that does not exist must not silently redirect the gate elsewhere; the
# process's own directory is the documented fallback.
gate_run "$G1" '{"session_id":"ghost-cwd","cwd":"/no/such/path/anywhere"}'
assert_blocks "engage/nonexistent-cwd-falls-back-and-still-blocks"

# A non-claim must never be produced by a parse error, even in a bare tree.
gate_run "" 'not json' "HOME=$ROOT/bare-tree" "PWD=$BARE"
if [ -n "$RUN_OUT" ] || [ "$RUN_STATUS" -eq 0 ]; then
	pass "engage/bare-tree-parse-error-is-still-exit-0"
else
	fail "engage/bare-tree-parse-error-is-still-exit-0" "exit $RUN_STATUS"
fi

# ==========================================================================
# 11. Resource limits — an oversized last_assistant_message
# ==========================================================================
#
# The Codex payload can carry the entire final assistant message. A multi-
# megabyte one must not be dragged through shell variables, and the whole run
# must finish well inside the pinned 120 s budget.

BIG_FILE="$ROOT/big-payload.json"
BIG_MSG="$ROOT/big-message.txt"
awk 'BEGIN { for (i = 0; i < 65536; i++) printf "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01\n" }' >"$BIG_MSG"
BIG_BYTES="$(wc -c <"$BIG_MSG" | tr -d ' ')"

if [ "$BIG_BYTES" -lt 4000000 ]; then
	fail "resource/fixture-is-actually-large" "only $BIG_BYTES bytes"
else
	pass "resource/fixture-is-actually-large"
fi

jq -Rs --arg t "turn-big" '{turn_id:$t, last_assistant_message:.}' <"$BIG_MSG" >"$BIG_FILE"

G_BIG="$(fresh_gate)"
BIG_START="$(date +%s)"
gate_run_file "$G_BIG" "$BIG_FILE"
BIG_END="$(date +%s)"
BIG_ELAPSED=$((BIG_END - BIG_START))

assert_blocks "resource/multi-megabyte-message-still-blocks"
if [ "$BIG_ELAPSED" -lt 120 ]; then
	pass "resource/multi-megabyte-message-within-the-120s-budget"
else
	fail "resource/multi-megabyte-message-within-the-120s-budget" "took ${BIG_ELAPSED}s"
fi

L_BIG="$(only_state_file "$G_BIG")"
assert_equals "resource/large-message-counted-not-copied" \
	"$BIG_BYTES" "$(state_field "$L_BIG" last_message_bytes)"
assert_equals "resource/large-payload-still-binds-a-derived-key-iteration-1" \
	"1" "$(state_field "$L_BIG" iteration)"

# The huge message must NOT have been written into the loop file.
BIG_STATE_BYTES="$(wc -c <"$L_BIG" | tr -d ' ')"
if [ "$BIG_STATE_BYTES" -lt 4096 ]; then
	pass "resource/loop-file-did-not-absorb-the-large-message"
else
	fail "resource/loop-file-did-not-absorb-the-large-message" "loop file is $BIG_STATE_BYTES bytes"
fi

# A deeply nested payload must not blow up the parser either.
DEEP="$ROOT/deep.json"
jq -nc '{session_id:"deep-sess", junk: [range(20000)]}' >"$DEEP"
G_DEEP="$(fresh_gate)"
gate_run_file "$G_DEEP" "$DEEP"
assert_blocks "resource/large-irrelevant-array-still-blocks"
assert_equals "resource/large-irrelevant-array-binds-normally" \
	"deep-sess" "$(state_field "$G_DEEP/deep-sess.state" binding_identity)"

# ==========================================================================
# 12. Single-read discipline
# ==========================================================================
#
# The ancestor ran `echo "$INPUT" | jq` three separate times. stdin must be read
# exactly once — the observable proof is that the gate works when stdin is a
# non-seekable PIPE, where a second read would return nothing and every field
# would come back empty (which would refuse for the WRONG reason).

G_PIPE="$(fresh_gate)"
outf="$ROOT/pipe-out"
errf="$ROOT/pipe-err"
{
	printf '%s' '{"session_id":"pipe-sess","cwd":"'"$ROOT"'"}'
} | env "GOAL_GATE_DIR=$G_PIPE" bash "$GATE" >"$outf" 2>"$errf"
pipe_status=$?
assert_equals "single-read/pipe-exit-is-0" "0" "$pipe_status"
assert_equals "single-read/pipe-stdin-binds-correctly" \
	"pipe-sess" "$(state_field "$G_PIPE/pipe-sess.state" binding_identity)"
case "$(cat "$outf")" in
*'"decision":"block"'*) pass "single-read/pipe-stdin-produces-a-decision" ;;
*) fail "single-read/pipe-stdin-produces-a-decision" "stdout was [$(cat "$outf")]" ;;
esac

# The gate must count exactly one jq process. Counting is done by shimming jq
# with a wrapper that appends to a tally file.
TALLY_DIR="$ROOT/tally-bin"
TALLY="$ROOT/jq-calls"
mkdir -p "$TALLY_DIR"
REAL_JQ="$(command -v jq)"
{
	printf '#!/usr/bin/env bash\n'
	printf 'printf "x" >> "%s"\n' "$TALLY"
	printf 'exec "%s" "$@"\n' "$REAL_JQ"
} >"$TALLY_DIR/jq"
chmod 755 "$TALLY_DIR/jq"
: >"$TALLY"

G_TALLY="$(fresh_gate)"
gate_run "$G_TALLY" "$CLAUDE_PAYLOAD" "PATH=$TALLY_DIR:$PATH"
assert_blocks "single-read/tallied-run-blocks"
JQ_CALLS="$(wc -c <"$TALLY" | tr -d ' ')"
assert_equals "single-read/exactly-one-jq-invocation" "1" "$JQ_CALLS"

# ==========================================================================
# 13. Decision-contract discipline — a sweep across every refusal fixture
# ==========================================================================
#
# Restated as one sweep because it is the property the whole feature rests on:
# NOTHING that goes wrong may ever produce an empty stdout (a non-claim).

G_SWEEP="$(fresh_gate)"
discipline_ok=1
discipline_note=""
for fixture in \
	'' \
	'   ' \
	'not json' \
	'{' \
	'{"a":' \
	'[]' \
	'[{"session_id":"a"}]' \
	'"str"' \
	'7' \
	'false' \
	'null' \
	'{}' \
	'{"session_id":null,"turn_id":null}' \
	'{"session_id":"","turn_id":""}' \
	'{"session_id":"   "}' \
	'{"session_id":"../escape"}' \
	'{"session_id":"a/b"}' \
	'{"session_id":".."}' \
	'{"session_id":"a\u0000b"}' \
	'{"cwd":"/tmp"}' \
	'{"stop_hook_active":true}' \
	'{"last_assistant_message":"done!"}' \
	'{"transcript_path":"/tmp/x.jsonl"}'; do
	gate_run "$G_SWEEP" "$fixture"
	if [ "$RUN_STATUS" -ne 0 ]; then
		discipline_ok=0
		discipline_note="fixture [$fixture] exited $RUN_STATUS"
		break
	fi
	if [ -z "$RUN_OUT" ]; then
		discipline_ok=0
		discipline_note="fixture [$fixture] emitted NO decision — a silent non-claim"
		break
	fi
	case "$RUN_OUT" in
	*'"decision":"block"'*) : ;;
	*)
		discipline_ok=0
		discipline_note="fixture [$fixture] did not block: [$RUN_OUT]"
		break
		;;
	esac
	if ! printf '%s' "$RUN_OUT" | jq -e '.decision == "block" and (.reason | type == "string") and (.reason | length > 0)' >/dev/null 2>&1; then
		discipline_ok=0
		discipline_note="fixture [$fixture] produced a malformed decision: [$RUN_OUT]"
		break
	fi
	case "$RUN_ERR" in
	*goal-gate:*) : ;;
	*)
		discipline_ok=0
		discipline_note="fixture [$fixture] refused silently (no diagnostic)"
		break
		;;
	esac
done
if [ "$discipline_ok" -eq 1 ]; then
	pass "discipline/every-bad-request-blocks-loudly-and-parseably"
else
	fail "discipline/every-bad-request-blocks-loudly-and-parseably" "$discipline_note"
fi

# No rejected request may leave a loop file behind in the sweep gate.
assert_equals "discipline/rejected-requests-leave-no-loop-file" \
	"<0 state files>" "$(only_state_file "$G_SWEEP")"

# The happy path is the ONLY path that reaches the completion decision, and
# even it refuses today — the acceptance check (T2.2) has not run.
G_FC="$(fresh_gate)"
gate_run "$G_FC" '{"session_id":"failclosed"}'
assert_blocks "discipline/a-well-formed-request-still-refuses-before-t2.2"
assert_reason_mentions "discipline/refusal-names-the-missing-check" "acceptance"

# --help must never be mistaken for a decision.
printf '' | bash "$GATE" --help >"$ROOT/help-out" 2>"$ROOT/help-err"
help_status=$?
assert_equals "discipline/help-exits-0" "0" "$help_status"
case "$(cat "$ROOT/help-out")" in
*'"decision"'*) fail "discipline/help-emits-no-decision" "--help printed a decision" ;;
*) pass "discipline/help-emits-no-decision" ;;
esac

# An unknown argument is a usage error, and a usage error is not a decision.
printf '' | bash "$GATE" --bogus >"$ROOT/bogus-out" 2>/dev/null
bogus_status=$?
assert_equals "discipline/unknown-argument-is-a-usage-error" "64" "$bogus_status"
assert_equals "discipline/usage-error-emits-no-decision" "" "$(cat "$ROOT/bogus-out")"

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
