#!/usr/bin/env bash
# test-bystander.sh — a SECOND session in a tree where a FIRST session is
# running a goal loop STANDS DOWN: its turn is not held.
#
# The gate follows the LOOP, not the tree. A conversation that is not driving
# the loop has nothing to prove, so holding its turn only takes an unrelated
# session hostage — including the loop's own driver after its session identity
# changes underneath it, which strands the owner behind a refusal naming a
# conversation that no longer exists.
#
# WHY STANDING DOWN CANNOT BECOME A BYPASS. A bystander writes no completion
# record, marks no criterion met, and never touches the owner's state file. The
# worst it can do is end its own turn — which establishes nothing about the
# goal. The owner stays blocked on its real criteria until they are met and
# evidenced, and that is where the guarantee has always lived.
#
# The guards below keep the stand-down narrow — these are the ways it could
# quietly become a fail-open:
#   1. the bystander stands down, and says so on stderr
#   2. the OWNER is still gated, before and after a bystander passes through
#   3. an EMPTY gate directory still refuses (a goal nobody is driving)
#   4. a STALE owner is RECLAIMED, not mistaken for a live one to defer to

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="${TEST_DIR}/../goal-gate-stop.sh"
PURSUE="${TEST_DIR}/../pursue-goal.sh"
CANCEL="${TEST_DIR}/../cancel.sh"
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

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'FAIL  could not create a work directory\n'
	exit 1
}

# new_repo <name> — a project with a goal folder and one unmet criterion.
new_repo() {
	local root="$WORK_DIR/$1"
	mkdir -p "$root/demo.goal"
	cat >"$root/demo.goal/goal.md" <<'MD'
# Demo
Criteria: `ACs.md`
MD
	cat >"$root/demo.goal/ACs.md" <<'MD'
# Done when

- [ ] **CRITICAL** The marker exists — `artifact.txt`
  - explanation: not created yet
MD
	printf '%s' "$root"
}

# fire <root> <session> — one turn end. Echoes stdout; stderr to $WORK_DIR/<s>.err
# and the exit status into FIRE_RC.
FIRE_RC=0
fire() {
	local root="$1" sess="$2" out
	out="$(printf '{"session_id":"%s","cwd":"%s","stop_hook_active":false}' "$sess" "$root" |
		(cd "$root" && env GOAL_GATE_AGENT=claude bash "$GATE" 2>"$WORK_DIR/$sess.err"))"
	FIRE_RC=$?
	printf '%s' "$out"
}

# --- the two positive assertions ------------------------------------------
#
# EVERY OUTCOME IS ASSERTED FOR WHAT IT IS, never for the absence of a word.
# Most of this suite used to read `case "$OUT" in *'"decision"'*) fail ;; *)
# pass ;; esac`, which passes on empty output — and therefore passes equally
# when the gate crashes, when the payload is malformed, when the fixture never
# built, and when jq is missing. A suite whose stand-down cases pass on a
# segfault is measuring nothing, and it is the stand-down cases that would have
# to catch a fail-open.
#
# So a stand-down must be: exit 0, NO decision, and a stated reason on stderr.
# The stderr requirement is what distinguishes "the gate considered this turn
# and let it go" from "the gate died before it decided".

# assert_stands_down <name> <out> <session> <stderr-needle>
assert_stands_down() {
	local name="$1" out="$2" sess="$3" needle="$4" err
	err="$(cat "$WORK_DIR/$sess.err" 2>/dev/null)"
	if [ "$FIRE_RC" -ne 0 ]; then
		fail "$name" "the gate exited $FIRE_RC; a stand-down must exit 0"
		return
	fi
	case "$out" in
	*'"decision"'*)
		fail "$name" "a decision was emitted, so the turn was not let go: [$out]"
		return
		;;
	esac
	case "$err" in
	*"$needle"*) : ;;
	*)
		fail "$name" "stderr does not say why the turn was let go (wanted [$needle]): [$err]"
		return
		;;
	esac
	pass "$name"
}

# assert_blocks <name> <out>
assert_blocks() {
	local name="$1" out="$2"
	if [ "$FIRE_RC" -ne 0 ]; then
		fail "$name" "the gate exited $FIRE_RC"
		return
	fi
	case "$out" in
	*'"decision":"block"'*) pass "$name" ;;
	*) fail "$name" "expected a block, got [$out]" ;;
	esac
}

# ws_base <gate-dir> <token> — the workstream born under <token>, whatever it is
# called now. Resolved through the `workstream_token` FIELD, because the gate
# renames the file on claim and again on retirement and the name stops carrying
# the token after the first hop.
ws_base() {
	local p b t
	for p in "$1"/*.state; do
		[ -f "$p" ] || continue
		t="$(bash "$LOOP_STATE" get "$p" workstream_token 2>/dev/null)" || t=""
		[ "$t" = "$2" ] || continue
		b="${p##*/}"
		printf '%s' "${b%.state}"
		return 0
	done
	printf ''
}

# birth_token <gate-dir> — the token of the one `_anon-*` file present, read
# from its NAME before any turn has run. Captured before the fixture is driven
# so that later assertions can compare a retired name against a LITERAL rather
# than against a value read back out of the file under test.
birth_token() {
	local p b
	for p in "$1"/_anon-*.state; do
		[ -f "$p" ] || continue
		b="${p##*/}"
		b="${b%.state}"
		printf '%s' "${b#_anon-}"
		return 0
	done
	printf ''
}

# --- 1. the bystander stands down -------------------------------------------

ROOT="$(new_repo owner-live)"
(cd "$ROOT" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)

OUT_A="$(fire "$ROOT" sessA)"
assert_blocks "owner/is-blocked-on-an-unmet-criterion" "$OUT_A"

# The owner's loop is named for the owner from the turn it was claimed.
if [ -f "$ROOT/.goal-gate/_ws-sessA.state" ]; then
	pass "owner/the-claimed-loop-is-named-for-its-owner"
else
	fail "owner/the-claimed-loop-is-named-for-its-owner" \
		"the gate directory holds: $(ls "$ROOT/.goal-gate")"
fi

OUT_B="$(fire "$ROOT" sessB)"
assert_stands_down "bystander/stands-down-its-turn-is-not-held" \
	"$OUT_B" sessB "owned by conversation sessA"

# A stand-down SAYS NOTHING TO THE OPERATOR — inverted from the predecessor,
# which emitted a `systemMessage` naming the owner and the `adopt` remedy. The
# bystander is by definition a conversation doing unrelated work, and the note
# fired on EVERY one of its turns for the whole life of the goal, so what was
# meant as a one-off explanation read as a permanent banner. Nothing is lost:
# the stand-down is still on stderr (asserted below) and still in the run log,
# and an owner that is genuinely gone is reclaimed automatically once its
# heartbeat ages past the liveness window, without anybody running `adopt`.
case "$OUT_B" in
"") pass "bystander/the-stand-down-is-silent-to-the-operator" ;;
*) fail "bystander/the-stand-down-is-silent-to-the-operator" \
	"a bystander turn put something on stdout: [$OUT_B]" ;;
esac

# Silent stand-downs are how a fail-open hides. The reason goes to stderr, and
# assert_stands_down above already required it — this names the owner
# specifically, because a stand-down that cannot say WHOSE loop it deferred to
# is the shape a bystander refusal used to take.
if grep -q "owned by conversation sessA" "$WORK_DIR/sessB.err" 2>/dev/null; then
	pass "bystander/stand-down-names-the-owning-conversation-on-stderr"
else
	fail "bystander/stand-down-names-the-owning-conversation-on-stderr" \
		"nothing on stderr explained why this turn was let through"
fi

if [ ! -e "$ROOT/demo.goal/completion-record.md" ] &&
	[ ! -e "$ROOT/.goal-gate/completion-record.md" ]; then
	pass "bystander/writes-no-completion-record"
else
	fail "bystander/writes-no-completion-record" "a bystander recorded a completion"
fi

# The old failure mode, named exactly: a phantom ACs path at the repo root.
if grep -q "no acceptance criteria file" "$WORK_DIR/sessB.err" 2>/dev/null; then
	fail "bystander/no-phantom-ACs-path-is-invented" \
		"the bystander still derived an ACs path from the gate directory's parent"
else
	pass "bystander/no-phantom-ACs-path-is-invented"
fi

# The bystander writes NO state file. It is not pursuing a goal here — it
# claimed no `_anon-*` workstream and no acceptance checklist sits where it
# stands — so the gate is passive and leaves nothing behind. (Earlier this
# self-bound a `<identity>.state` every turn; that was the "does very little
# when not pursuing" complaint, now fixed.)
if [ -e "$ROOT/.goal-gate/sessB.state" ]; then
	fail "compat/the-bystander-writes-no-state" "a bystander self-bound a state file on a passive turn"
else
	pass "compat/the-bystander-writes-no-state"
fi

# The owner is unaffected: still bound, still blocked, on the REAL criteria.
OUT_A2="$(fire "$ROOT" sessA)"
assert_blocks "owner/still-gated-after-a-bystander-passed-through" "$OUT_A2"
if [ -f "$ROOT/.goal-gate/_ws-sessA.state" ] && [ ! -e "$ROOT/.goal-gate/_ws-sessB.state" ]; then
	pass "owner/a-bystander-renamed-nothing"
else
	fail "owner/a-bystander-renamed-nothing" \
		"the gate directory holds: $(ls "$ROOT/.goal-gate")"
fi

# --- 2. an empty gate directory is a PASSIVE turn ---------------------------
#
# A `.goal-gate/` holding no workstream, with no acceptance checklist where the
# session stands, is a tree where no goal is being pursued. The gate does very
# little: it STANDS DOWN silently rather than blocking a conversation over a
# goal nobody started. (A goal a conversation IS driving still blocks — that is
# the OWNER path, exercised throughout test-decision and above.)

BARE="$WORK_DIR/bare-gate"
mkdir -p "$BARE/.goal-gate"
OUT_C="$(fire "$BARE" sessC)"
assert_stands_down "compat/empty-gate-directory-stands-down" \
	"$OUT_C" sessC "no goal loop exists in this tree"
case "$OUT_C" in
"") pass "compat/an-empty-gate-directory-says-nothing-on-stdout" ;;
*) fail "compat/an-empty-gate-directory-says-nothing-on-stdout" \
	"an unowned gate directory did not stand down silently: [$OUT_C]" ;;
esac

# --- 3. BACKWARDS COMPATIBILITY: a stale owner is reclaimed, not skipped -----
#
# Pass 3 runs BEFORE pass 4, so a dead owner is taken over rather than treated
# as a live one to tiptoe around. If this ever inverted, a crashed session would
# strand its loop forever and every later session would silently pass through —
# a fail-open wearing the bystander rule as a disguise.

ROOT2="$(new_repo owner-stale)"
(cd "$ROOT2" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)
fire "$ROOT2" sessOld >/dev/null

# Backdate the owner's heartbeat so it is genuinely stale.
#
# NOT via GOAL_GATE_LIVENESS_WINDOW=0: gg_liveness_window rejects any value that
# is not a positive integer and falls back to 900, precisely so a malformed
# override can never disable liveness. Driving the real timestamp is the only
# way to exercise the real mechanism.
STALE_AT=$(( $(date +%s) - 100000 ))
HB_COUNT=0
while IFS= read -r hb; do
	[ -n "$hb" ] || continue
	printf '%s\n' "$STALE_AT" >"$hb"
	HB_COUNT=$((HB_COUNT + 1))
done <<EOF
$(find "$ROOT2/.goal-gate" -name heartbeat -type f 2>/dev/null)
EOF

if [ "$HB_COUNT" -gt 0 ]; then
	pass "compat/the-owner-heartbeat-was-found-to-backdate"
else
	fail "compat/the-owner-heartbeat-was-found-to-backdate" \
		"no heartbeat file under $ROOT2/.goal-gate — the staleness case below would be vacuous"
fi

OUT_D="$(fire "$ROOT2" sessNew)"
assert_blocks "compat/stale-owner-is-reclaimed-not-passed-through" "$OUT_D"

if grep -qiE "reclaimed" "$WORK_DIR/sessNew.err" 2>/dev/null; then
	pass "compat/the-reclamation-is-reported"
else
	fail "compat/the-reclamation-is-reported" "stderr did not mention the reclamation"
fi

# The takeover renames the loop to its NEW owner, and the dead owner's name is
# gone. A reclaim that left the old name in place would tell every later reader
# — `cancel.sh status`, an operator, this suite — that a conversation which is
# not driving the loop is the one that holds it.
if [ -f "$ROOT2/.goal-gate/_ws-sessNew.state" ] &&
	[ ! -e "$ROOT2/.goal-gate/_ws-sessOld.state" ]; then
	pass "compat/a-reclaim-renames-the-loop-to-its-new-owner"
else
	fail "compat/a-reclaim-renames-the-loop-to-its-new-owner" \
		"the gate directory holds: $(ls "$ROOT2/.goal-gate")"
fi

# --- 4. independent trees are unaffected ------------------------------------
#
# Two sessions in DIFFERENT repositories were always fine. Asserted so the new
# branch cannot regress it by matching on the wrong scope.

ROOT3="$(new_repo other-repo)"
(cd "$ROOT3" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)
OUT_E="$(fire "$ROOT3" sessOther)"
assert_blocks "compat/an-owner-in-another-tree-is-still-gated" "$OUT_E"

# --- 5. a workstream that has ENDED is not adopted by anybody (S63/S64/S65) -
#
# THE FIELD DEFECT. Nothing consulted `status` when deciding which workstream a
# conversation binds to, so a FINISHED goal whose owner had gone quiet for a
# liveness window was reclaimed by the next unrelated session in that repo —
# which was then held to acceptance criteria it had never heard of, for a goal
# that was already complete. Reproduced before the fix as a RECLAIMED note
# followed by a block.
#
# Both halves matter: no reclaim, and no block.

ROOT4="$(new_repo finished-goal)"
(cd "$ROOT4" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)

# THE BIRTH TOKEN IS CAPTURED BEFORE ANY TURN RUNS, from the name `pursue-goal`
# gave the file, and the retired name below is compared against a LITERAL built
# from it. Reading the token back out of the file under test and then asserting
# the file is called `_ended-<owner>-<that token>` is a tautology: it would hold
# for any token whatsoever, including the wrong one taken off a previous
# owner's session id, which is precisely the bug worth catching.
TOKEN4="$(birth_token "$ROOT4/.goal-gate")"
if [ -n "$TOKEN4" ]; then
	pass "ended/the-fixture-has-a-workstream-to-retire"
else
	fail "ended/the-fixture-has-a-workstream-to-retire" \
		"no _anon-*.state under $ROOT4/.goal-gate — every case below would be vacuous"
fi

fire "$ROOT4" sessDone >/dev/null # claim it: _anon-<token> -> _ws-sessDone

# ...and finish it FOR REAL, through the permit path, rather than by writing
# `status=complete` into the file by hand. A hand-written status exercises the
# status filters and nothing else; only a real completion exercises the
# retirement that the filters are now the backstop for.
: >"$ROOT4/artifact.txt"
cat >"$ROOT4/demo.goal/ACs.md" <<'MD'
# Done when

- [x] **CRITICAL** The marker exists — `artifact.txt`
  - evidence: `ls artifact.txt` → `artifact.txt` (exit 0)
MD
OUT_DONE="$(fire "$ROOT4" sessDone)"
case "$OUT_DONE" in
*'"decision"'*)
	fail "ended/the-fixture-actually-completes" \
		"the goal did not reach a permit, so nothing was retired: [$OUT_DONE]"
	;;
*) pass "ended/the-fixture-actually-completes" ;;
esac

# THE RETIRED NAME, ASSERTED AGAINST A LITERAL.
DONE_STATE="$ROOT4/.goal-gate/_ended-sessDone-$TOKEN4.state"
if [ -f "$DONE_STATE" ]; then
	pass "ended/a-finished-loop-is-renamed-to-its-retired-name"
else
	fail "ended/a-finished-loop-is-renamed-to-its-retired-name" \
		"expected _ended-sessDone-$TOKEN4.state; the gate directory holds: $(ls "$ROOT4/.goal-gate")"
fi
if [ -e "$ROOT4/.goal-gate/_ws-sessDone.state" ]; then
	fail "ended/the-finished-loop-leaves-the-adoptable-pool" \
		"_ws-sessDone.state is still in the pool"
else
	pass "ended/the-finished-loop-leaves-the-adoptable-pool"
fi
# The claim moves with it, so nothing is left looking unclaimed under the old
# name for a later conversation to take.
if [ -d "$ROOT4/.goal-gate/_ended-sessDone-$TOKEN4.claim.1" ] &&
	[ ! -e "$ROOT4/.goal-gate/_ws-sessDone.claim.1" ]; then
	pass "ended/the-claim-is-retired-with-the-workstream"
else
	fail "ended/the-claim-is-retired-with-the-workstream" \
		"the gate directory holds: $(ls "$ROOT4/.goal-gate")"
fi

# Backdate the heartbeat so the ended workstream ALSO looks abandoned: that is
# the exact combination that used to be reclaimed.
find "$ROOT4/.goal-gate" -name heartbeat -type f -exec sh -c 'echo 1 > "$1"' _ {} \; 2>/dev/null

OUT_F="$(fire "$ROOT4" sessAfter)"
assert_stands_down "ended/a-completed-workstream-does-not-hold-a-later-session" \
	"$OUT_F" sessAfter "no goal loop exists in this tree"

if grep -qi "reclaimed" "$WORK_DIR/sessAfter.err" 2>/dev/null; then
	fail "ended/a-completed-workstream-is-not-reclaimed" \
		"a finished workstream was adopted by an unrelated session"
else
	pass "ended/a-completed-workstream-is-not-reclaimed"
fi
# The stranger wrote nothing at all — no self-bound state file, no claim on the
# retired loop.
if [ -e "$ROOT4/.goal-gate/sessAfter.state" ]; then
	fail "ended/a-stranger-writes-nothing-beside-a-retired-loop" \
		"a bystander self-bound a state file"
else
	pass "ended/a-stranger-writes-nothing-beside-a-retired-loop"
fi
RETIRED_OWNER="$(head -1 "$ROOT4/.goal-gate/_ended-sessDone-$TOKEN4.claim.1/owner" 2>/dev/null | tr -d '\r\n')"
if [ "$RETIRED_OWNER" = "sessDone" ]; then
	pass "ended/a-stranger-does-not-take-the-retired-claim"
else
	fail "ended/a-stranger-does-not-take-the-retired-claim" \
		"the retired claim is owned by [$RETIRED_OWNER]"
fi

# A STRANGER WHOSE IDENTITY IS A DASH-PREFIX OF THE OWNER'S. `_ended-sess-*`
# also matches `_ended-sess-happy-*`, so a glob cannot decide ownership — only
# the candidate's own `binding_identity` can. Here `sessDone` owns the retired
# loop and `sess` is a different conversation whose name is a prefix of it.
OUT_PFX="$(fire "$ROOT4" sess)"
assert_stands_down "ended/a-prefix-of-the-owners-name-does-not-bind-the-retired-loop" \
	"$OUT_PFX" sess "no goal loop exists in this tree"
if [ -e "$ROOT4/.goal-gate/sess.state" ]; then
	fail "ended/the-prefix-stranger-writes-nothing" "a prefix stranger self-bound a state file"
else
	pass "ended/the-prefix-stranger-writes-nothing"
fi

# THE OWNER RETURNS AND RE-EVALUATES. A permit is not a one-shot: adding an
# unmet criterion to a finished checklist must withdraw it on the next turn.
# Retirement is invisibility to BINDING, never to the owner.
cat >"$ROOT4/demo.goal/ACs.md" <<'MD'
# Done when

- [x] **CRITICAL** The marker exists — `artifact.txt`
  - evidence: `ls artifact.txt` → `artifact.txt` (exit 0)
- [ ] **CRITICAL** A second thing is done — `second.txt`
  - explanation: added to the checklist after the run was recorded as complete
MD
OUT_REGRESS="$(fire "$ROOT4" sessDone)"
assert_blocks "ended/the-owner-re-evaluates-its-own-retired-loop" "$OUT_REGRESS"
case "$OUT_REGRESS" in
*'1 of 2'*) pass "ended/the-withdrawn-permit-names-the-new-shortfall" ;;
*) fail "ended/the-withdrawn-permit-names-the-new-shortfall" "[$OUT_REGRESS]" ;;
esac

# The completed loop is still on disk for `cancel.sh status` and for audit — it
# is invisible to BINDING, not deleted — and `status` can still read it.
if [ -f "$DONE_STATE" ]; then
	pass "ended/the-retired-workstream-is-kept-on-disk-under-its-retired-name"
else
	fail "ended/the-retired-workstream-is-kept-on-disk-under-its-retired-name" \
		"$DONE_STATE was removed"
fi
# The output is captured and THEN searched, never piped straight into `grep -q`:
# `grep -q` exits at the first match, cancel.sh dies of SIGPIPE, and `pipefail`
# turns the whole pipeline non-zero — so a matching line would report a failure.
STATUS4="$(cd "$ROOT4" && bash "$CANCEL" status 2>&1)"
case "$STATUS4" in
*"status complete"*) pass "ended/cancel-status-still-reports-the-finished-run" ;;
*) fail "ended/cancel-status-still-reports-the-finished-run" "$STATUS4" ;;
esac

# --- 6. adopt hands a live loop to the next conversation ---------------------
#
# The remedy the stand-down message names has to work. A resumed session gets a
# new identity, so without this the only recovery is to outwait the liveness
# window with nothing indicating that waiting is the remedy.

ROOT5="$(new_repo adoptable)"
(cd "$ROOT5" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)
TOKEN5="$(birth_token "$ROOT5/.goal-gate")"
fire "$ROOT5" sessOwner >/dev/null

OUT_G="$(fire "$ROOT5" sessResumed)"
assert_stands_down "adopt/before-adopting-the-new-session-is-not-held" \
	"$OUT_G" sessResumed "owned by conversation sessOwner"

# `adopt` has to accept the `_ws-*` name a claimed loop now carries. Refusing it
# would make the remedy refuse every loop there has ever been a reason to hand
# over, since a loop is only worth adopting once somebody has claimed it.
if (cd "$ROOT5" && bash "$CANCEL" adopt >"$WORK_DIR/adopt.out" 2>&1); then
	pass "adopt/exits-0"
else
	fail "adopt/exits-0" "$(cat "$WORK_DIR/adopt.out")"
fi
if grep -q "released _ws-sessOwner" "$WORK_DIR/adopt.out" 2>/dev/null; then
	pass "adopt/names-the-claimed-workstream-it-released"
else
	fail "adopt/names-the-claimed-workstream-it-released" "$(cat "$WORK_DIR/adopt.out")"
fi

OUT_H="$(fire "$ROOT5" sessResumed)"
assert_blocks "adopt/after-adopting-the-new-session-is-gated" "$OUT_H"

# The adopted loop is renamed to its NEW owner — a `_ws-` to `_ws-` hop — and it
# is still the SAME loop: the birth token is unchanged.
ADOPTED_STATE="$ROOT5/.goal-gate/_ws-sessResumed.state"
if [ -f "$ADOPTED_STATE" ]; then
	pass "adopt/the-adopted-loop-is-renamed-to-its-new-owner"
else
	fail "adopt/the-adopted-loop-is-renamed-to-its-new-owner" \
		"the gate directory holds: $(ls "$ROOT5/.goal-gate")"
fi
if [ "$(bash "$LOOP_STATE" get "$ADOPTED_STATE" claimed_by 2>/dev/null)" = "sessResumed" ]; then
	pass "adopt/the-new-owner-is-recorded"
else
	fail "adopt/the-new-owner-is-recorded" \
		"claimed_by=[$(bash "$LOOP_STATE" get "$ADOPTED_STATE" claimed_by 2>/dev/null)]"
fi
if [ "$(bash "$LOOP_STATE" get "$ADOPTED_STATE" workstream_token 2>/dev/null)" = "$TOKEN5" ]; then
	pass "adopt/the-hand-over-keeps-the-same-loop"
else
	fail "adopt/the-hand-over-keeps-the-same-loop" \
		"the birth token changed: expected [$TOKEN5] got [$(bash "$LOOP_STATE" get "$ADOPTED_STATE" workstream_token 2>/dev/null)]"
fi

# Adopting is not finishing: the criteria are untouched by the hand-over.
if [ ! -e "$ROOT5/demo.goal/completion-record.md" ] &&
	[ ! -e "$ROOT5/.goal-gate/completion-record.md" ]; then
	pass "adopt/adopting-claims-no-completion"
else
	fail "adopt/adopting-claims-no-completion" "a completion record appeared"
fi

# An ENDED loop is history, not something to hand over.
if (cd "$ROOT4" && bash "$CANCEL" adopt >"$WORK_DIR/adopt-done.out" 2>&1); then
	fail "adopt/refuses-to-hand-over-a-loop-that-has-ended" \
		"$(cat "$WORK_DIR/adopt-done.out")"
else
	pass "adopt/refuses-to-hand-over-a-loop-that-has-ended"
fi

# --- 7. a CANCELLED loop stops holding its OWNER ----------------------------
#
# The field defect of 2026-08-05: cancel.sh reported the loop ended, `cancel.sh
# status` agreed there was no active loop, and the Stop hook went on refusing the
# owner's every turn — because the owner still resolved the cancelled workstream
# through its surviving claim, and every terminal status was re-evaluated alike.
# Cancelling means "stop working on this", so there is nothing left to prove.
# `complete` keeps being re-evaluated (test-decision.sh pins the regression
# property); the reported ENDS do not.

ROOT6="$(new_repo cancelled-owner)"
(cd "$ROOT6" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)
TOKEN6="$(birth_token "$ROOT6/.goal-gate")"

OUT_I="$(fire "$ROOT6" sessCancel)"
assert_blocks "cancelled/the-owner-is-gated-before-the-cancel" "$OUT_I"

if (cd "$ROOT6" && bash "$CANCEL" cancel . --force >"$WORK_DIR/cancel6.out" 2>&1); then
	pass "cancelled/cancel-exits-0"
else
	fail "cancelled/cancel-exits-0" "$(cat "$WORK_DIR/cancel6.out")"
fi
# `cancel.sh` records the status; it does NOT rename. It runs in another process
# with no claim of its own, so renaming a workstream out of the pool from there
# would mean duplicating the whole claim protocol. The gate does it instead, on
# the first turn it sees the ended loop — asserted below.
ITER_AT_CANCEL="$(bash "$LOOP_STATE" get "$ROOT6/.goal-gate/_ws-sessCancel.state" iteration 2>/dev/null)"

OUT_J="$(fire "$ROOT6" sessCancel)"
assert_stands_down "cancelled/the-owner-is-not-held-after-the-cancel" \
	"$OUT_J" sessCancel "already reached a reported END"

# The gate retires it on that turn, so a cancelled loop leaves the pool too —
# all six terminal statuses end up in the same namespace whichever process wrote
# them.
CANCELLED_STATE="$ROOT6/.goal-gate/_ended-sessCancel-$TOKEN6.state"
if [ -f "$CANCELLED_STATE" ]; then
	pass "cancelled/the-gate-retires-a-loop-cancelled-by-another-process"
else
	fail "cancelled/the-gate-retires-a-loop-cancelled-by-another-process" \
		"expected _ended-sessCancel-$TOKEN6.state; the gate directory holds: $(ls "$ROOT6/.goal-gate")"
fi

# ...and nothing else is written to the ended loop: no iteration bump, no stall
# accounting, no `refused_unmet` decision recorded after the cancel.
assert_iter="$(bash "$LOOP_STATE" get "$CANCELLED_STATE" iteration 2>/dev/null)"
if [ "$assert_iter" = "$ITER_AT_CANCEL" ]; then
	pass "cancelled/the-ended-loop-is-not-written-to"
else
	fail "cancelled/the-ended-loop-is-not-written-to" \
		"iteration advanced from [$ITER_AT_CANCEL] to [$assert_iter] after the cancel"
fi
if [ "$(bash "$LOOP_STATE" get "$CANCELLED_STATE" status 2>/dev/null)" = "cancelled" ]; then
	pass "cancelled/the-status-stays-cancelled"
else
	fail "cancelled/the-status-stays-cancelled" \
		"status=[$(bash "$LOOP_STATE" get "$CANCELLED_STATE" status 2>/dev/null)]"
fi

# Retiring is not deleting: `cancel.sh status` must still be able to report the
# run somebody just cancelled, which is exactly when they ask.
STATUS6="$(cd "$ROOT6" && bash "$CANCEL" status 2>&1)"
case "$STATUS6" in
*"status cancelled"*) pass "cancelled/status-still-reports-the-cancelled-run" ;;
*) fail "cancelled/status-still-reports-the-cancelled-run" "$STATUS6" ;;
esac

# Standing down is never a completion.
if [ -e "$ROOT6/demo.goal/completion-record.md" ] || [ -e "$ROOT6/.goal-gate/completion-record.md" ]; then
	fail "cancelled/standing-down-claims-no-completion" "a completion record appeared"
else
	pass "cancelled/standing-down-claims-no-completion"
fi

# Restarting still works — a fresh loop is claimed and gates again.
(cd "$ROOT6" && env GOAL_GATE_AGENT=claude GOAL_GATE_SKIP_REGISTRATION_CHECK=1 \
	bash "$PURSUE" demo.goal >/dev/null 2>&1)
OUT_K="$(fire "$ROOT6" sessCancel)"
assert_blocks "cancelled/a-restarted-loop-gates-again" "$OUT_K"

# The restart takes the `_ws-sessCancel` name the retired loop vacated, and the
# retired one is still there beside it under its own name. Two runs by one
# conversation in one gate directory coexist without either standing on the
# other — which they could not do if retirement were a status field alone.
if [ -f "$ROOT6/.goal-gate/_ws-sessCancel.state" ] && [ -f "$CANCELLED_STATE" ]; then
	pass "cancelled/the-restarted-and-retired-loops-coexist"
else
	fail "cancelled/the-restarted-and-retired-loops-coexist" \
		"the gate directory holds: $(ls "$ROOT6/.goal-gate")"
fi
if [ "$(bash "$LOOP_STATE" get "$ROOT6/.goal-gate/_ws-sessCancel.state" workstream_token 2>/dev/null)" != "$TOKEN6" ]; then
	pass "cancelled/the-restarted-loop-is-a-different-run"
else
	fail "cancelled/the-restarted-loop-is-a-different-run" \
		"the restarted loop carries the cancelled run's birth token"
fi

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
