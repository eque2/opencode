#!/usr/bin/env bash
# test-proof-of-fire.sh — conformance suite for the proof-of-fire marker, the
# thing that keeps Codex support from being a fail-open.
#
# The property under test is not "the marker file is written". It is: a gate
# that has never been OBSERVED to fire must not be treated as governing, and a
# proof earned for ONE registration must not authorise a DIFFERENT one.
#
# Note what is deliberately NOT a property: "a new gate version loses the trust
# its predecessor earned". That was the original rule and it was wrong in
# practice — Codex keys trust on the registered command, not the file's bytes,
# so every eque2-code release invalidated a proof Codex had never withdrawn and
# sent the operator round the loop again. Content drift is now soft (exit 4):
# reported, non-blocking, self-healing on the next fire. A moved registration
# is still hard (exit 2).
#
# Plain bash asserts, matching the sibling suites — bats is not installed and
# must not be introduced.

set -uo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROOF="${TEST_DIR}/../proof-of-fire.sh"
GATE="${TEST_DIR}/../goal-gate-stop.sh"
PURSUE="${TEST_DIR}/../pursue-goal.sh"
INSTALL="${TEST_DIR}/../install.sh"

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

assert_exit() {
	local name="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		pass "$name"
	else
		fail "$name" "expected exit $expected, got $actual"
	fi
}

WORK_DIR="$(mktemp -d 2>/dev/null)" || {
	printf 'FAIL  could not create a work directory\n'
	exit 1
}

export GOAL_GATE_PROOF_DIR="$WORK_DIR/proof"
export CODEX_HOME="$WORK_DIR/default-codex-home"
FAKE_GATE="$WORK_DIR/gate.sh"
cp "$GATE" "$FAKE_GATE"

rc=0

# --- the empty state -------------------------------------------------------
#
# A machine that has never run the gate is the FIRST-RUN state, and it must read
# as "not proven" rather than "nothing to worry about".

bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "empty/never-fired-is-not-proven" 1 "$rc"

# --- recording a fire ------------------------------------------------------

rc=0
bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "happy/record-succeeds" 0 "$rc"

rc=0
bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "happy/recorded-fire-is-proven" 0 "$rc"

if [ -f "$GOAL_GATE_PROOF_DIR/codex" ]; then
	pass "happy/marker-at-expected-path"
else
	fail "happy/marker-at-expected-path" "no marker at $GOAL_GATE_PROOF_DIR/codex"
fi

if grep -qE '^[0-9a-f]{64}'$'\t' "$GOAL_GATE_PROOF_DIR/codex" 2>/dev/null; then
	pass "happy/marker-records-a-sha256"
else
	fail "happy/marker-records-a-sha256" "marker carries no well-formed hash"
fi

if awk -F'\t' 'NR == 1 && $4 ~ /^\// { found = 1 } END { exit !found }' \
	"$GOAL_GATE_PROOF_DIR/codex" 2>/dev/null; then
	pass "happy/marker-records-the-registration"
else
	fail "happy/marker-records-the-registration" "marker records no absolute registration path"
fi

if awk -F'\t' 'NR == 1 && length($3) == 64 && $3 ~ /^[0-9a-f]+$/ { found = 1 } END { exit !found }' \
	"$GOAL_GATE_PROOF_DIR/codex" 2>/dev/null; then
	pass "happy/marker-records-the-codex-home-scope"
else
	fail "happy/marker-records-the-codex-home-scope" "marker records no trust-store scope"
fi

# Each Codex home owns a separate hook trust store. A proof earned by the CLI
# cannot approve an isolated JetBrains Air home for the same command.
CLI_CODEX_HOME="$WORK_DIR/codex-cli-home"
AIR_CODEX_HOME="$WORK_DIR/air-codex-home"
mkdir -p "$CLI_CODEX_HOME" "$AIR_CODEX_HOME"
CODEX_HOME="$CLI_CODEX_HOME" \
	bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1
rc=0
CODEX_HOME="$CLI_CODEX_HOME" GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/cli-proof-approves-cli" 0 "$rc"
rc=0
CODEX_HOME="$AIR_CODEX_HOME" GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/cli-proof-does-not-approve-air" 2 "$rc"
CODEX_HOME="$AIR_CODEX_HOME" \
	bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1
rc=0
CODEX_HOME="$AIR_CODEX_HOME" GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/air-fire-approves-air" 0 "$rc"
rc=0
env -u CODEX_HOME GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/hidden-codex-home-fails-closed" 2 "$rc"

# A fire whose host hides CODEX_HOME belongs to an unscoped record. It must not
# become a proof for the explicit default CLI home later.
HIDDEN_GATE="$WORK_DIR/hidden-home-gate.sh"
cp "$GATE" "$HIDDEN_GATE"
env -u CODEX_HOME bash "$PROOF" record codex "$HIDDEN_GATE" >/dev/null 2>&1
rc=0
CODEX_HOME="$WORK_DIR/default-codex-home" GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$HIDDEN_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/hidden-fire-does-not-authorize-cli" 2 "$rc"

# A symlink alias names the same Codex trust store. Canonical directory paths
# must share one proof scope.
REAL_CODEX_HOME="$WORK_DIR/real-codex-home"
ALIAS_CODEX_HOME="$WORK_DIR/codex-home-alias"
mkdir -p "$REAL_CODEX_HOME"
ln -s "$REAL_CODEX_HOME" "$ALIAS_CODEX_HOME"
CODEX_HOME="$REAL_CODEX_HOME" \
	bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1
rc=0
CODEX_HOME="$ALIAS_CODEX_HOME" GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "scope/symlink-home-matches-canonical-home" 0 "$rc"

# Record fields use tabs and newlines as structure. Reject a definition that
# could create a forged extra field or record.
before_records="$(wc -l <"$GOAL_GATE_PROOF_DIR/codex" | tr -d ' ')"
BAD_DEFINITION="$WORK_DIR/bad"$'\t'"definition"
bash "$PROOF" record codex "$FAKE_GATE" "$BAD_DEFINITION" >/dev/null 2>&1
after_records="$(wc -l <"$GOAL_GATE_PROOF_DIR/codex" | tr -d ' ')"
if [ "$before_records" = "$after_records" ]; then
	pass "security/control-character-definition-is-not-recorded"
else
	fail "security/control-character-definition-is-not-recorded" \
		"the marker changed from $before_records to $after_records records"
fi
rc=0
bash "$PROOF" check codex "$FAKE_GATE" "$BAD_DEFINITION" >/dev/null 2>&1 || rc=$?
assert_exit "security/control-character-definition-is-not-accepted" 2 "$rc"

# Concurrent hook fires must not lose either read-modify-write update.
rm -rf "$GOAL_GATE_PROOF_DIR"
mkdir -p "$GOAL_GATE_PROOF_DIR"
CONCURRENT_GATES=""
for index in 1 2 3 4 5 6 7 8; do
	concurrent_gate="$WORK_DIR/concurrent-$index.sh"
	cp "$GATE" "$concurrent_gate"
	CONCURRENT_GATES="$CONCURRENT_GATES $concurrent_gate"
	CODEX_HOME="$CODEX_HOME" \
		bash "$PROOF" record codex "$concurrent_gate" >/dev/null 2>&1 &
done
wait
concurrent_missing=0
for concurrent_gate in $CONCURRENT_GATES; do
	rc=0
	bash "$PROOF" check codex "$concurrent_gate" >/dev/null 2>&1 || rc=$?
	[ "$rc" -eq 0 ] || concurrent_missing=$((concurrent_missing + 1))
done
if [ "$concurrent_missing" -eq 0 ]; then
	pass "concurrency/all-proof-records-survive"
else
	fail "concurrency/all-proof-records-survive" \
		"$concurrent_missing concurrent records were lost"
fi
bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1

# --- THE upgrade case ------------------------------------------------------
#
# The one that matters most. A previously-proven machine takes an eque2-code
# release: the gate's bytes change, its registered command does not. Codex never
# withdrew trust, so this must NOT send the operator back to re-prove — that
# treadmill is the bug this contract was changed to kill. Soft, not hard.

printf '\n# an upgrade\n' >>"$FAKE_GATE"
rc=0
bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "upgrade/new-gate-version-is-soft-not-blocking" 4 "$rc"

rc=0
bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
bash "$PROOF" check codex "$FAKE_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "upgrade/next-fire-clears-the-drift" 0 "$rc"

# The hard case, kept hard: a proof earned for one registered command must not
# authorise a different one. This is the fail-open the whole mechanism exists to
# prevent, and softening the upgrade case must not have softened this.
rc=0
bash "$PROOF" check codex "$FAKE_GATE" "$WORK_DIR/somewhere-else.sh" >/dev/null 2>&1 || rc=$?
assert_exit "upgrade/moved-registration-is-hard-stale" 2 "$rc"

# --- legacy markers --------------------------------------------------------
#
# Markers written before `def=` existed prove a fire happened here but not
# against which registration, so they cannot be held to a rule they predate.
# Matching content is full proof; drifted content is soft. Either way the
# operator is not asked to re-prove a machine they already proved.

LEGACY_GATE="$WORK_DIR/legacy-gate.sh"
cp "$GATE" "$LEGACY_GATE"
rm -rf "$GOAL_GATE_PROOF_DIR"
mkdir -p "$GOAL_GATE_PROOF_DIR"
printf 'hash=%s\nat=2026-01-01T00:00:00Z\n' \
	"$(shasum -a 256 -- "$LEGACY_GATE" | cut -d' ' -f1)" >"$GOAL_GATE_PROOF_DIR/codex"

rc=0
bash "$PROOF" check codex "$LEGACY_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "legacy/marker-without-def-still-proves" 0 "$rc"

rc=0
GOAL_GATE_PROOF_REQUIRE_DEFINITION=1 \
	GOAL_GATE_PROOF_REQUIRE_SCOPE=1 \
	bash "$PROOF" check codex "$LEGACY_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "legacy/project-command-requires-an-exact-record" 2 "$rc"

printf '\n# drift after a legacy proof\n' >>"$LEGACY_GATE"
rc=0
bash "$PROOF" check codex "$LEGACY_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "legacy/drifted-legacy-marker-is-soft-not-blocking" 4 "$rc"

rm -rf "$GOAL_GATE_PROOF_DIR"
bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1

# --- error propagation -----------------------------------------------------

rc=0
bash "$PROOF" check codex "$WORK_DIR/does-not-exist.sh" >/dev/null 2>&1 || rc=$?
assert_exit "error/unhashable-gate-is-not-proven" 2 "$rc"

rc=0
bash "$PROOF" >/dev/null 2>&1 || rc=$?
assert_exit "error/no-verb-is-usage" 3 "$rc"

# --- the marker must not look like a gate directory -------------------------
#
# REGRESSION. The first cut of this stored the marker in `$HOME/.goal-gate/`.
# `.goal-gate` is the directory the gate walks UP the tree to find, so that
# turned $HOME — an ancestor of nearly every checkout — into a gate directory,
# and every session on the machine would have believed it had a bound
# workstream. Asserted on the DEFAULT path, because the bug lived in the
# default and a test that only ever exercises an override would have missed it.

DEFAULT_PATH="$(env -u GOAL_GATE_PROOF_DIR -u XDG_STATE_HOME HOME="$WORK_DIR/home" \
	bash "$PROOF" path codex 2>/dev/null)"
case "$DEFAULT_PATH" in
*/.goal-gate/*)
	fail "layout/marker-is-not-inside-a-gate-directory" \
		"default proof path sits inside a .goal-gate directory: $DEFAULT_PATH"
	;;
"")
	fail "layout/marker-is-not-inside-a-gate-directory" "no default path resolved"
	;;
*)
	pass "layout/marker-is-not-inside-a-gate-directory"
	;;
esac

# And the behavioural form of the same property: recording a fire must not
# create anything the gate would later mistake for a workstream above it.
POF_HOME="$WORK_DIR/home2"
mkdir -p "$POF_HOME"
env -u GOAL_GATE_PROOF_DIR -u XDG_STATE_HOME HOME="$POF_HOME" \
	bash "$PROOF" record codex "$FAKE_GATE" >/dev/null 2>&1
if [ -n "$(find "$POF_HOME" -name '.goal-gate' -type d 2>/dev/null)" ]; then
	fail "layout/recording-creates-no-gate-directory" \
		"recording a fire created a .goal-gate directory under HOME"
else
	pass "layout/recording-creates-no-gate-directory"
fi

# --- security --------------------------------------------------------------
#
# The agent name reaches a filesystem path. An unrecognised one must be refused
# outright rather than sanitised into something plausible.

rc=0
bash "$PROOF" path '../../etc/passwd' >/dev/null 2>&1 || rc=$?
assert_exit "security/agent-name-not-a-path" 1 "$rc"

rc=0
bash "$PROOF" path '' >/dev/null 2>&1 || rc=$?
assert_exit "security/empty-agent-refused" 1 "$rc"

# --- the gate records its OWN fire ------------------------------------------
#
# The bootstrap depends on this: the gate records BEFORE it does any work, so a
# turn with no loop bound still proves the host runs the hook. If this ever
# stopped holding, `install.sh prove` would demand a fire that could never
# happen and Codex would be unusable rather than merely ungated.

rm -rf "$GOAL_GATE_PROOF_DIR"
UNBOUND="$WORK_DIR/unbound"
mkdir -p "$UNBOUND"
(
	cd "$UNBOUND" || exit 1
	printf '{"session_id":"s","transcript_path":"/dev/null","stop_hook_active":false}' |
		env GOAL_GATE_AGENT=codex bash "$GATE" >/dev/null 2>&1
)
if [ -f "$GOAL_GATE_PROOF_DIR/codex" ]; then
	pass "bootstrap/gate-records-even-with-no-loop-bound"
else
	fail "bootstrap/gate-records-even-with-no-loop-bound" \
		"the gate fired but recorded nothing — install.sh prove would be unsatisfiable"
fi

# REGRESSION (2026-07-26). Codex does not promise to export CODEX_HOME,
# CODEX_SANDBOX, or AI_AGENT to hook commands. The real Stop payload already
# carries the authoritative discriminator (`turn_id`), so proof recording must
# use that payload rather than depend on optional process environment. The
# previous test forced GOAL_GATE_AGENT=codex and therefore masked the field
# failure: /hooks showed a trusted hook, the gate really fired, but `prove
# codex` stayed NOT PROVEN forever because the fire was recorded as `unknown`.
rm -rf "$GOAL_GATE_PROOF_DIR"
(
	cd "$UNBOUND" || exit 1
	printf '{"session_id":"session-1","turn_id":"turn-1","hook_event_name":"Stop"}' |
		env -u GOAL_GATE_AGENT -u CODEX_HOME -u CODEX_SANDBOX -u AI_AGENT \
			-u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT bash "$GATE" >/dev/null 2>&1
)
if [ -f "$GOAL_GATE_PROOF_DIR/codex" ]; then
	pass "bootstrap/codex-payload-records-without-agent-environment"
else
	fail "bootstrap/codex-payload-records-without-agent-environment" \
		"the Codex hook fired with a real Codex-shaped payload but no optional agent environment, and prove codex remained unsatisfiable"
fi

# --- an unidentified host records nothing ----------------------------------

rm -rf "$GOAL_GATE_PROOF_DIR"
(
	cd "$UNBOUND" || exit 1
	printf '{"session_id":"s","transcript_path":"/dev/null","stop_hook_active":false}' |
		env GOAL_GATE_AGENT=unknown bash "$GATE" >/dev/null 2>&1
)
if [ -f "$GOAL_GATE_PROOF_DIR/unknown" ]; then
	fail "security/unknown-agent-records-nothing" "an unnamed host wrote a marker"
else
	pass "security/unknown-agent-records-nothing"
fi

# --- claude is exempt -------------------------------------------------------
#
# Claude has no trust layer, so a good registration IS the evidence there.
# Requiring proof under Claude would be friction bought with nothing.

rm -rf "$GOAL_GATE_PROOF_DIR"
rc=0
(
	set -uo pipefail
	# Sourcing defines the predicate without running the script: pursue-goal.sh
	# guards its own entry on BASH_SOURCE[0] = $0. It then sets PG_PROOF/PG_GATE
	# from its own defaults, so there is nothing to inject here — the marker
	# directory being empty is the whole setup.
	# shellcheck source=/dev/null
	source "$PURSUE" >/dev/null 2>&1
	pg_proof_ok claude
) || rc=$?
assert_exit "claude/exempt-with-no-marker-present" 0 "$rc"

# The same predicate, same empty marker directory, under Codex: the contrast is
# the test. If this ever returned 0 the exemption above would be vacuous.
rc=0
(
	set -uo pipefail
	# shellcheck source=/dev/null
	source "$PURSUE" >/dev/null 2>&1
	pg_proof_ok codex
) >/dev/null 2>&1 || rc=$?
assert_exit "codex/not-exempt-with-no-marker-present" 1 "$rc"

# --- pursue-goal proves the hook Codex is actually registered to run --------
#
# The checkout copy and the shared runtime copy intentionally diverge here.
# `install.sh prove` records a hash for the shared path returned by
# `install_gate_path`; pursue-goal must check that same path, not its own
# checkout-local goal-gate-stop.sh. Reversing the marker proves that a proof for
# an unrelated hook remains unacceptable.
RUNTIME_BASE="$WORK_DIR/runtime-base"
RUNTIME_GATE="$RUNTIME_BASE/goal-gate/gate/goal-gate-stop.sh"
mkdir -p "$(dirname -- "$RUNTIME_GATE")"
cp "$GATE" "$RUNTIME_GATE"
printf '\n# runtime copy deliberately differs from the checkout\n' >>"$RUNTIME_GATE"

# Run the predicate in one controlled environment. Keeping the override in a
# single helper avoids leaking it to the surrounding proof cases.
pursue_runtime_proof() (
	set -uo pipefail
	export GOAL_GATE_RUNTIME_HOME="$RUNTIME_BASE"
	# shellcheck source=/dev/null
	source "$PURSUE" >/dev/null 2>&1
	pg_proof_ok codex
)

rm -rf "$GOAL_GATE_PROOF_DIR"
bash "$PROOF" record codex "$RUNTIME_GATE" >/dev/null 2>&1
rc=0
pursue_runtime_proof >/dev/null 2>&1 || rc=$?
assert_exit "pursue/runtime-proof-allows-divergent-checkout" 0 "$rc"

# The release path, end to end: the registered gate is upgraded in place. The
# loop must still bind. If this ever goes back to 1, every eque2-code release
# blocks every Codex goal until the operator re-proves — the exact regression
# this contract change exists to prevent.
rm -rf "$GOAL_GATE_PROOF_DIR"
bash "$PROOF" record codex "$RUNTIME_GATE" >/dev/null 2>&1
printf '\n# a shipped upgrade to the registered gate\n' >>"$RUNTIME_GATE"
rc=0
pursue_runtime_proof >/dev/null 2>&1 || rc=$?
assert_exit "pursue/upgraded-runtime-gate-still-binds" 0 "$rc"

rm -rf "$GOAL_GATE_PROOF_DIR"
bash "$PROOF" record codex "$GATE" >/dev/null 2>&1
rc=0
pursue_runtime_proof >/dev/null 2>&1 || rc=$?
assert_exit "pursue/checkout-proof-does-not-authorize-runtime" 1 "$rc"
rm -rf "$GOAL_GATE_PROOF_DIR"

# --- diagnostics do not misdiagnose every missed fire as untrusted ----------
#
# A trusted definition can still be absent from the current session, disabled
# by the hooks feature or policy, or fail before execution. The 2026-07-26
# incident had /hooks reporting trusted while the old proof recorder discarded
# the real fire. `prove` must report the observation and the next checks, not
# contradict Codex's UI with a single asserted cause.
PROVE_HOME="$WORK_DIR/prove-home"
GOAL_GATE_SKILLS_SOURCE="$(dirname -- "$TEST_DIR")" \
	bash "$INSTALL" install codex "$PROVE_HOME" >/dev/null 2>&1
PROVE_OUT="$(bash "$INSTALL" prove codex "$PROVE_HOME" 2>&1)"
case "$PROVE_OUT" in
*"registered but UNTRUSTED"*)
	fail "diagnostic/not-proven-is-not-declared-untrusted" \
		"prove contradicted a potentially trusted /hooks state: [$PROVE_OUT]"
	;;
*) pass "diagnostic/not-proven-is-not-declared-untrusted" ;;
esac
case "$PROVE_OUT" in
*"/hooks"*reopen*|*"/hooks"*restart*|*"/hooks"*session*)
	pass "diagnostic/not-proven-names-trust-and-session-checks"
	;;
*)
	fail "diagnostic/not-proven-names-trust-and-session-checks" \
		"prove did not direct the operator to inspect trust and reload the hook in a new session: [$PROVE_OUT]"
	;;
esac

# --- the suite must not be able to revoke a real machine's proof -------------
#
# REGRESSION. Twelve suites fire the gate, which records at the DEFAULT
# per-machine path — so `run-all.sh` overwrote the developer's real Codex marker
# with a checkout path and hard-blocked a machine that was genuinely proven.
# Asserted statically against run-all.sh, because the failure is the ABSENCE of
# an override and a behavioural test would have to trash the real marker to
# observe it.
if grep -qE '^export GOAL_GATE_PROOF_DIR=' "$TEST_DIR/run-all.sh" 2>/dev/null; then
	pass "hermetic/run-all-sandboxes-the-proof-marker"
else
	fail "hermetic/run-all-sandboxes-the-proof-marker" \
		"run-all.sh does not export GOAL_GATE_PROOF_DIR — a suite run would rewrite the real marker"
fi

# --- a stray fire must not retract a proven registration --------------------
#
# The other half of the same defect: running the checkout copy by hand recorded
# over the registered one. Observing a NEW registration must ADD to what this
# machine has proven, never retract what it already proved.
rm -rf "$GOAL_GATE_PROOF_DIR"
bash "$PROOF" record codex "$RUNTIME_GATE" >/dev/null 2>&1
bash "$PROOF" record codex "$GATE" >/dev/null 2>&1
rc=0
bash "$PROOF" check codex "$RUNTIME_GATE" >/dev/null 2>&1 || rc=$?
assert_exit "multi/stray-fire-does-not-retract-the-registered-proof" 0 "$rc"

rc=0
bash "$PROOF" check codex "$GATE" >/dev/null 2>&1 || rc=$?
assert_exit "multi/both-observed-registrations-remain-proven" 0 "$rc"
rm -rf "$GOAL_GATE_PROOF_DIR"

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
