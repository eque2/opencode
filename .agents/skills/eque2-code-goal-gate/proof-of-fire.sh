#!/usr/bin/env bash
# proof-of-fire — evidence that the stop gate ACTUALLY RAN on this machine,
# under this agent, for this exact gate script.
#
# Why this exists
# ---------------
# Codex gates hook execution on persisted trust and SILENTLY SKIPS an untrusted
# hook: the session ends normally, exit 0, nothing on stderr. A registration
# that is present, correct and executable can therefore govern precisely
# nothing, and every check that inspects CONFIGURATION rather than BEHAVIOUR
# reports success over an inert gate. `install.sh doctor` says so itself: it can
# report a missing command and a non-executable one, but not an untrusted one —
# "which the host alone can resolve".
#
# Configuration cannot answer this question. Only a fire can. So the gate
# records that it ran, and pursue-goal refuses to bind a loop under an agent
# that has never been observed to run it. A run nothing is checking is the one
# outcome this whole mechanism exists to prevent; refusing to start is the
# honest response to not knowing.
#
# What goes stale, and what does not
# ----------------------------------
# The marker records TWO things, and they answer different questions.
#
#   the DEFINITION — the command path Codex was told to run. This is what
#         Codex's trust decision is keyed on, so it is what governs validity. If
#         this machine has been observed running that exact command, the host's
#         "yes, run this" is still the same yes we observed.
#
#   the CONTENT hash of the gate script. Informational. It says which
#         implementation was observed, which is worth knowing and worth
#         reporting — but it is NOT the trust key.
#
# Originally `hash` governed validity, and that was wrong in practice: every
# eque2-code release ships a new goal-gate-stop.sh, so the content hash changed
# on every upgrade and the operator was sent to re-prove a gate whose
# registration Codex had never stopped trusting. Proving something once per
# machine that gets invalidated once per release is not a proof, it is a
# treadmill — and a check that cries wolf on every install trains the operator
# to ignore the one time it is real.
#
# So content drift is now SOFT: reported, never blocking, and self-healing —
# the next real fire rewrites the marker. A moved registration is HARD, because
# that genuinely is a definition Codex has not vouched for. And if Codex DID
# withdraw trust over the new source, the gate simply will not fire, the marker
# will not refresh, and the drift notice keeps showing: the honest signal
# survives without a false alarm on the common path.
#
# Verbs: record <agent> <gate-script> [definition]  (never fails; from the hook)
#        check  <agent> <gate-script> [definition]
#                 0=proven  1=no marker  2=registration moved (hard)
#                 3=usage   4=implementation changed (soft, non-blocking)
#        path   <agent>                 print the marker path
#
# Records also include the active Codex home. Each home has its own trust store.
# A CLI proof must not authorize an isolated IDE home such as JetBrains Air.

set -uo pipefail

# NOT `$HOME/.goal-gate/…`, and this is not a style preference. `.goal-gate` is
# the marker directory the gate itself walks UP the tree to find, so putting the
# proof inside one would have the gate manufacture its own trigger in $HOME — an
# ancestor of virtually every checkout on the machine. Every session everywhere
# would then believe it had a bound workstream. test-binding.sh's "no gate
# directory" fixture caught precisely this; the name is load-bearing.
POF_DIR="${GOAL_GATE_PROOF_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/goal-gate/proof}"

# pof_hash <file> — sha256 of a file, or empty when it cannot be read.
# shasum is POSIX-ubiquitous; sha256sum is the coreutils spelling. Trying both
# beats assuming either, and an unreadable file yields empty rather than a
# plausible-looking wrong answer.
pof_hash() {
	local f="${1-}" out=""
	[ -n "$f" ] && [ -r "$f" ] || return 0
	if command -v shasum >/dev/null 2>&1; then
		out="$(shasum -a 256 -- "$f" 2>/dev/null)"
	elif command -v sha256sum >/dev/null 2>&1; then
		out="$(sha256sum -- "$f" 2>/dev/null)"
	fi
	printf '%s' "${out%% *}"
}

# pof_norm <path> — an absolute, canonical spelling of a path, so that the
# definition recorded by the hook (which sees the path Codex invoked) compares
# equal to the one `install.sh prove` resolves. Falls back to the raw string
# when the path cannot be resolved; a best-effort spelling beats an empty one,
# because an empty definition would silently disable the comparison entirely.
pof_norm() {
	local p="${1-}" d b
	[ -n "$p" ] || return 0
	if [ -d "$p" ]; then
		(cd -- "$p" 2>/dev/null && pwd -P 2>/dev/null) && return 0
	fi
	d="$(dirname -- "$p" 2>/dev/null)" || d=""
	b="$(basename -- "$p" 2>/dev/null)" || b=""
	if [ -n "$d" ] && [ -d "$d" ]; then
		d="$(cd -- "$d" 2>/dev/null && pwd -P 2>/dev/null)" || d=""
		[ -n "$d" ] && { printf '%s/%s' "${d%/}" "$b"; return 0; }
	fi
	printf '%s' "$p"
}

# pof_text_hash <text> — a field-safe identity for a trust-store path.
pof_text_hash() {
	local text="${1-}" out=""
	if command -v shasum >/dev/null 2>&1; then
		out="$(printf '%s' "$text" | shasum -a 256 2>/dev/null)"
	elif command -v sha256sum >/dev/null 2>&1; then
		out="$(printf '%s' "$text" | sha256sum 2>/dev/null)"
	fi
	printf '%s' "${out%% *}"
}

# pof_scope <agent> — hash the effective hook trust store for this host.
pof_scope() {
	local agent="${1-}" home
	case "$agent" in
	codex)
		# A strict project proof must name the effective trust store. If the
		# host hides CODEX_HOME, fail closed instead of folding that host into
		# the default CLI scope and accepting proof earned elsewhere.
		if [ -z "${CODEX_HOME-}" ] &&
		   [ "${GOAL_GATE_PROOF_REQUIRE_SCOPE:-0}" = "1" ]; then
			return 1
		fi
		if [ -n "${CODEX_HOME-}" ]; then
			home="$(pof_norm "$CODEX_HOME")"
			pof_text_hash "codex:$home"
		else
			# Keep an observed fire, but never attribute it to the default CLI
			# trust store. An explicit home must not inherit this unknown scope.
			pof_text_hash "codex:unscoped"
		fi
		;;
	claude) pof_text_hash "claude" ;;
	*) return 1 ;;
	esac
}

pof_path() {
	local agent="${1-}"
	# An unnamed or exotic agent must not escape into a filesystem path.
	case "$agent" in
	claude | codex) printf '%s/%s' "${POF_DIR%/}" "$agent" ;;
	*) return 1 ;;
	esac
}

# pof_record <agent> <gate-script> — note that the gate ran. ALWAYS exits 0:
# this is called from inside the hook, and a bookkeeping failure must never
# become a gate failure. A gate that cannot write its marker still gates.
# A marker holds one record per trust scope and registration. Fields are
# tab-separated, with the path last so spaces round-trip:
#
#   <sha256>\t<iso8601>\t<scope-sha256>\t<definition>
#
# Multi-record, and that is load-bearing rather than tidy. A single-record marker
# is destroyed by any fire from a path other than the registered one — running
# the checkout copy by hand, or a test suite firing the gate — and under
# definition keying that silently downgrades a proven machine to "registration
# moved", which BLOCKS. The suite did exactly this and it was invisible while
# only content was keyed, because every copy of the gate is byte-identical.
# So: observing a new registration ADDS to what this machine has proven; it
# never retracts an older one.
POF_MAX_RECORDS=512

# pof_lock <marker> — serialize read-modify-replace updates to one marker.
# A stale or busy lock never makes the Stop hook fail. The next fire can retry.
pof_lock() {
	local marker="${1-}" lock attempts=0
	lock="${marker}.lock"
	while [ "$attempts" -lt 500 ]; do
		if mkdir -- "$lock" 2>/dev/null; then
			printf '%s' "$lock"
			return 0
		fi
		attempts=$((attempts + 1))
		sleep 0.01
	done
	return 1
}

pof_record() {
	local agent="${1-}" script="${2-}" def="${3-}" marker hash scope tmp at lock
	marker="$(pof_path "$agent")" || return 0
	hash="$(pof_hash "$script")"
	[ -n "$hash" ] || return 0
	scope="$(pof_scope "$agent")" || return 0
	[ -n "$scope" ] || return 0
	# The definition defaults to the gate's own invoked path, which IS the
	# command the host was registered to run.
	[ -n "$def" ] || def="$script"
	case "$def" in
	*$'\t'* | *$'\n'* | *$'\r'*) return 0 ;;
	esac
	def="$(pof_norm "$def")"
	at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')"

	mkdir -p -- "$(dirname -- "$marker")" 2>/dev/null || return 0
	lock="$(pof_lock "$marker")" || return 0
	tmp="$marker.$$.$RANDOM"
	{
		# This trust-scope registration is replaced; every other one survives.
		# Legacy `key=value` lines are dropped only once a real record exists to
		# supersede them, which this write is.
		if [ -f "$marker" ]; then
			awk -F'\t' -v s="$scope" -v d="$def" \
				'!(NF >= 4 && $3 == s && $4 == d)' "$marker" 2>/dev/null |
				grep -v '^hash=' | grep -v '^def=' | grep -v '^at=' |
				tail -n "$((POF_MAX_RECORDS - 1))"
		fi
		printf '%s\t%s\t%s\t%s\n' "$hash" "$at" "$scope" "$def"
	} >"$tmp" 2>/dev/null || {
		rm -f -- "$tmp" 2>/dev/null
		rmdir -- "$lock" 2>/dev/null
		return 0
	}
	mv -f -- "$tmp" "$marker" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
	rmdir -- "$lock" 2>/dev/null
	return 0
}

# pof_check <agent> <gate-script> [definition]
#   0 proven · 1 never fired · 2 registration never observed (hard) · 4 content drift (soft)
pof_check() {
	local agent="${1-}" script="${2-}" def="${3-}" marker current scope legacy found_hash records
	marker="$(pof_path "$agent")" || return 1
	[ -f "$marker" ] || return 1

	current="$(pof_hash "$script")"
	# An unhashable script is not a licence to trust the marker.
	[ -n "$current" ] || return 2

	[ -n "$def" ] || def="$script"
	case "$def" in
	*$'\t'* | *$'\n'* | *$'\r'*) return 2 ;;
	esac
	def="$(pof_norm "$def")"
	scope="$(pof_scope "$agent")" || return 2
	[ -n "$scope" ] || return 2

	# Legacy marker, written before registrations were recorded. It proves a fire
	# happened here but not against which command, so it cannot be held to a rule
	# it predates. Matching content is full proof; drift is soft, and the next
	# fire replaces it with a real record.
	legacy="$(sed -n 's/^hash=//p' "$marker" 2>/dev/null | head -1)"
	if [ -n "$legacy" ]; then
		# A project registration needs proof for its exact command. A legacy
		# marker predates command and trust-scope records, so it cannot authorise
		# that source.
		if [ "${GOAL_GATE_PROOF_REQUIRE_DEFINITION:-0}" = "1" ] ||
		   [ "${GOAL_GATE_PROOF_REQUIRE_SCOPE:-0}" = "1" ]; then
			return 2
		fi
		[ "$legacy" = "$current" ] || return 4
		return 0
	fi

	records="$(grep -c '	' -- "$marker" 2>/dev/null || printf '0')"
	[ "$records" -gt 0 ] 2>/dev/null || return 1

	found_hash="$(awk -F'\t' -v s="$scope" -v d="$def" \
		'NF >= 4 && $3 == s && $4 == d { print $1; exit }' "$marker" 2>/dev/null)"
	# Three-field records predate trust-scope identity. Keep them compatible for
	# the legacy user installer, but never let them approve a project hook.
	if [ -z "$found_hash" ] && [ "${GOAL_GATE_PROOF_REQUIRE_SCOPE:-0}" != "1" ]; then
		found_hash="$(awk -F'\t' -v d="$def" \
			'NF == 3 && $3 == d { print $1; exit }' "$marker" 2>/dev/null)"
	fi
	# A command this machine has never been observed to run is not vouched for by
	# a proof earned elsewhere. This is the fail-open the mechanism exists to stop.
	[ -n "$found_hash" ] || return 2
	[ "$found_hash" = "$current" ] || return 4
	return 0
}

case "${1-}" in
record)
	shift
	pof_record "${1-}" "${2-}" "${3-}"
	;;
check)
	shift
	pof_check "${1-}" "${2-}" "${3-}"
	;;
path)
	shift
	pof_path "${1-}"
	;;
*)
	printf 'usage: proof-of-fire.sh {record|check|path} <agent> [gate-script] [definition]\n' >&2
	exit 3
	;;
esac
