#!/usr/bin/env bash
# loop-state.sh — portable, escape-correct read/write for the goal-gate loop file.
#
# Persists the loop's own state — status, iteration, failure hash, binding
# identity, history — as a flat, line-oriented, human-readable file:
#
#     name=escaped_value
#
# One field per line. Field names are exact and anchored; values may contain ANY
# byte a shell string can hold (`| & \ ' " $( ) ;` and newlines all round-trip
# verbatim). NUL is the single exception — no bash string can carry it.
#
# Usage:
#   loop-state.sh get [--raw] <state-file> <field>
#   loop-state.sh set        <state-file> <field> <value>
#   loop-state.sh --help
#
# Or source it and call loop_state_get / loop_state_set directly.
#
# `get` prints the decoded value on stdout and exits 0. With --raw no trailing
# newline is added, so a value that itself ends in a newline round-trips exactly
# (command substitution would otherwise eat it).
#
# On ANY problem a `loop-state:` diagnostic goes to stderr and the exit is
# non-zero — an unknown NEVER resolves to a usable value, and no field ever
# silently defaults.
#
# Exit codes:
#   0  success
#   1  field absent (distinct from a present-but-empty value, which is 0)
#   2  invalid input (empty path, empty/ill-formed field name)
#   3  state file does not exist, or is not a regular file
#   5  filesystem failure (unwritable directory, mktemp/rename refused, lock)
#   6  corrupt state file (malformed line, bad escape, duplicate field)
#   64 usage error
#
# ---------------------------------------------------------------------------
# Escaping contract (the whole safety story)
#
# Write encodes exactly three sequences, backslash FIRST:
#     \  -> \\        LF -> \n        CR -> \r
# Nothing else is touched, so shell metacharacters are stored verbatim and there
# is no second escaping layer to get out of step.
#
# Read decodes with pure bash parameter expansion and a single IFS split. State
# content is NEVER passed to eval, an unquoted heredoc, `printf "$value"`, a
# command substitution, sed, or grep. `$(rm -rf /)` in a value is inert text on
# every path through this file.

# --- character constants ---------------------------------------------------

LOOP_STATE_LF=$'\n'
LOOP_STATE_CR=$'\r'

# --- diagnostics -----------------------------------------------------------

loop_state_die() {
	local code="$1"
	shift
	printf 'loop-state: %s\n' "$*" >&2
	return "$code"
}

# --- validation ------------------------------------------------------------

# loop_state_valid_name <name> — a field name is [A-Za-z_][A-Za-z0-9_]*
loop_state_valid_name() {
	local name="${1-}"
	case "$name" in
	'') return 1 ;;
	[0-9]*) return 1 ;;
	*[!A-Za-z0-9_]*) return 1 ;;
	esac
	return 0
}

# --- escaping --------------------------------------------------------------
#
# Both transforms run in awk rather than bash parameter expansion. That is a
# portability requirement, not a style choice: bash 3.2 (still the /bin/bash on
# macOS) evaluates `${s//pat/rep}` quadratically, so a few thousand lines of
# loop history took tens of seconds. awk is POSIX-mandated, byte-exact, and
# linear.
#
# State content reaches awk ONLY on stdin — never interpolated into the awk
# program, never through eval, a heredoc, or a command substitution. There is no
# path on which a stored value becomes code.

# The awk programs read the payload on stdin and write the transform on stdout.
# `\` is written as sprintf("%c", 92) throughout, so no escaping layer of awk's
# own can be mis-stacked on top of ours.

# shellcheck disable=SC2016  # `$0`/`$1` are awk fields; NOT expanding them in
# the shell is the entire D2 defence. Double quotes here would be the defect.
LOOP_STATE_AWK_ENCODE='
BEGIN { BS = sprintf("%c", 92); CR = sprintf("%c", 13) }
{
	# Split on backslash and rejoin with a doubled one. Concatenating pieces
	# avoids gsub, whose replacement string re-interprets \ and & .
	n = split($0, a, /\\/)
	out = a[1]
	for (i = 2; i <= n; i++) out = out BS BS a[i]

	m = split(out, b, CR)
	out2 = b[1]
	for (i = 2; i <= m; i++) out2 = out2 BS "r" b[i]

	# Records after the first were separated by a newline in the input.
	if (NR > 1) printf "%s", BS "n"
	printf "%s", out2
}
'

# shellcheck disable=SC2016  # as above: awk fields, deliberately unexpanded.
LOOP_STATE_AWK_DECODE='
BEGIN { BS = sprintf("%c", 92); CR = sprintf("%c", 13); LF = sprintf("%c", 10) }
{
	n = split($0, a, /\\/)

	# Pass 1 — validate the WHOLE encoding before emitting a single byte, so a
	# corrupt value never dribbles half a result onto stdout.
	pending = 0
	for (i = 2; i <= n; i++) {
		if (pending) { pending = 0; continue }
		if (a[i] == "") { pending = 1; continue }
		c = substr(a[i], 1, 1)
		if (c != "n" && c != "r") exit 6
	}
	if (pending) exit 6

	# Pass 2 — emit.
	printf "%s", a[1]
	pending = 0
	for (i = 2; i <= n; i++) {
		if (pending) { pending = 0; printf "%s", a[i]; continue }
		if (a[i] == "") { printf "%s", BS; pending = 1; continue }
		c = substr(a[i], 1, 1)
		if (c == "n") printf "%s%s", LF, substr(a[i], 2)
		else printf "%s%s", CR, substr(a[i], 2)
	}
}
'

# loop_state_encode_stdout <value> — write the encoded form of a value to
# stdout with no trailing newline.
loop_state_encode_stdout() {
	local s="${1-}"

	# Fast path: nothing needs encoding, so no fork. This covers the ordinary
	# scalar fields (status, iteration, failure hash, binding identity).
	case "$s" in
	*\\* | *"$LOOP_STATE_LF"* | *"$LOOP_STATE_CR"*) : ;;
	*)
		printf '%s' "$s"
		return 0
		;;
	esac

	# The appended newline is what makes awk's record split lossless: joining
	# the records back with \n reproduces the value exactly, including one that
	# legitimately ends in a newline.
	printf '%s\n' "$s" | LC_ALL=C awk "$LOOP_STATE_AWK_ENCODE"
}

# loop_state_decode_stdout <encoded> — write the decoded value to stdout,
# byte-exactly and with nothing appended. Returns 6 if the encoding is
# malformed (a stray or trailing backslash, an unknown escape).
#
# Output goes straight to stdout rather than through a variable: command
# substitution strips trailing newlines, which would silently corrupt any value
# that legitimately ends in one.
loop_state_decode_stdout() {
	local s="${1-}"

	# Fast path: no escapes at all.
	case "$s" in
	*\\*) : ;;
	*)
		printf '%s' "$s"
		return 0
		;;
	esac

	printf '%s\n' "$s" | LC_ALL=C awk "$LOOP_STATE_AWK_DECODE"
}

# --- writer lock -----------------------------------------------------------
#
# `set` is read-modify-write, so an atomic rename alone prevents corruption but
# not lost updates. An mkdir lock (atomic on every POSIX filesystem) serialises
# writers. Readers never lock: a rename is atomic, so a reader always sees one
# complete version of the file.

LOOP_STATE_LOCK_TRIES="${LOOP_STATE_LOCK_TRIES:-200}"
LOOP_STATE_LOCK_SLEEP="${LOOP_STATE_LOCK_SLEEP:-0.05}"

loop_state_lock() {
	local lockdir="$1.lock"
	local tries=0
	while ! mkdir -- "$lockdir" 2>/dev/null; do
		tries=$((tries + 1))
		if [ "$tries" -ge "$LOOP_STATE_LOCK_TRIES" ]; then
			loop_state_die 5 "cannot acquire writer lock after ${tries} tries: $lockdir (remove it if no writer is running)" || return
		fi
		sleep "$LOOP_STATE_LOCK_SLEEP"
	done
}

loop_state_unlock() {
	rmdir -- "$1.lock" 2>/dev/null || true
}

# --- read ------------------------------------------------------------------

# loop_state_get_value <state-file> <field>
#
# Prints the decoded value with NO trailing newline. Exit 1 means absent.
loop_state_get_value() {
	local file="${1-}" field="${2-}"

	if [ -z "$file" ]; then
		loop_state_die 2 "empty state-file path" || return
	fi
	if ! loop_state_valid_name "$field"; then
		loop_state_die 2 "invalid field name: ${field:-<empty>}" || return
	fi

	if [ -d "$file" ]; then
		loop_state_die 3 "is a directory, not a state file: $file" || return
	fi
	if [ ! -e "$file" ]; then
		loop_state_die 3 "no such state file: $file" || return
	fi
	if [ ! -f "$file" ]; then
		loop_state_die 3 "not a regular file: $file" || return
	fi
	if [ ! -r "$file" ]; then
		loop_state_die 3 "state file is not readable: $file" || return
	fi

	local line name raw found=0 hit='' lineno=0

	# `read -r` keeps backslashes literal; IFS= keeps leading/trailing blanks.
	# The `|| [ -n "$line" ]` tail handles a final line with no newline.
	while IFS= read -r line || [ -n "$line" ]; do
		lineno=$((lineno + 1))

		case "$line" in
		*=*) : ;;
		*)
			loop_state_die 6 "corrupt state file: line ${lineno} has no '=': $file" || return
			;;
		esac

		name="${line%%=*}"
		raw="${line#*=}"

		if ! loop_state_valid_name "$name"; then
			loop_state_die 6 "corrupt state file: line ${lineno} has an invalid field name: $file" || return
		fi

		# ANCHORED: exact string equality, never a prefix or substring match.
		# This is what stops field `iter` from matching `iteration`.
		if [ "$name" = "$field" ]; then
			found=$((found + 1))
			if [ "$found" -gt 1 ]; then
				loop_state_die 6 "corrupt state file: field '$field' appears more than once: $file" || return
			fi
			hit="$raw"
		fi
	done <"$file"

	if [ "$found" -eq 0 ]; then
		return 1
	fi

	if ! loop_state_decode_stdout "$hit"; then
		loop_state_die 6 "corrupt state file: field '$field' has a malformed escape: $file" || return
	fi
}

# loop_state_get <state-file> <field>
#
# As loop_state_get_value, but terminates the value with a newline for ordinary
# line-oriented callers. Any newlines the value itself ends with are collapsed
# into that terminator — callers needing byte-exact values must use
# loop_state_get_value / `get --raw`.
loop_state_get() {
	local value
	value="$(loop_state_get_value "$@")" || return
	printf '%s\n' "$value"
}

# --- write -----------------------------------------------------------------

# loop_state_set_locked <state-file> <field> <value> — caller holds the lock.
loop_state_set_locked() {
	local file="$1" field="$2" value="$3"
	local dir tmp line name encoded written=0 lineno=0

	dir="$(dirname -- "$file")"
	if [ ! -d "$dir" ]; then
		loop_state_die 5 "state file's directory does not exist: $dir" || return
	fi
	if [ ! -w "$dir" ]; then
		loop_state_die 5 "state file's directory is not writable: $dir" || return
	fi
	if [ -e "$file" ] && [ ! -f "$file" ]; then
		loop_state_die 3 "not a regular file: $file" || return
	fi

	# Command substitution is safe here ONLY because the encoded form can never
	# end in a newline — LF is encoded as `\n` — so there is nothing to strip.
	encoded="$(loop_state_encode_stdout "$value")"

	# D9: a UNIQUE temp name in the TARGET's directory — never a fixed `.tmp`
	# suffix (two writers would share it) and never $TMPDIR (rename across
	# filesystems is not atomic).
	if ! tmp="$(mktemp -- "${dir%/}/.loop-state.XXXXXX")"; then
		loop_state_die 5 "cannot create temporary file in: $dir" || return
	fi

	if [ -f "$file" ]; then
		while IFS= read -r line || [ -n "$line" ]; do
			lineno=$((lineno + 1))

			case "$line" in
			*=*) : ;;
			*)
				rm -f -- "$tmp"
				loop_state_die 6 "refusing to write over corrupt state: line ${lineno} has no '=': $file" || return
				;;
			esac

			name="${line%%=*}"

			if ! loop_state_valid_name "$name"; then
				rm -f -- "$tmp"
				loop_state_die 6 "refusing to write over corrupt state: line ${lineno} has an invalid field name: $file" || return
			fi

			if [ "$name" = "$field" ]; then
				# Replace in place on first sight; drop any duplicate, so a
				# write also repairs a doubled field rather than preserving it.
				if [ "$written" -eq 0 ]; then
					printf '%s=%s\n' "$field" "$encoded" >>"$tmp" || {
						rm -f -- "$tmp"
						loop_state_die 5 "write failed: $tmp" || return
					}
					written=1
				fi
				continue
			fi

			printf '%s\n' "$line" >>"$tmp" || {
				rm -f -- "$tmp"
				loop_state_die 5 "write failed: $tmp" || return
			}
		done <"$file"
	fi

	if [ "$written" -eq 0 ]; then
		printf '%s=%s\n' "$field" "$encoded" >>"$tmp" || {
			rm -f -- "$tmp"
			loop_state_die 5 "write failed: $tmp" || return
		}
	fi

	# Match an existing file's permissions so an atomic replace never widens it.
	if [ -f "$file" ]; then
		chmod --reference="$file" -- "$tmp" 2>/dev/null ||
			chmod "$(loop_state_mode "$file")" -- "$tmp" 2>/dev/null || true
	fi

	# The rename is the commit point: a reader sees the old file or the new
	# one, never a partial write, and a kill before this leaves the previous
	# state completely intact.
	if ! mv -f -- "$tmp" "$file"; then
		rm -f -- "$tmp"
		loop_state_die 5 "cannot replace state file: $file" || return
	fi
}

# loop_state_mode <file> — octal permission bits, portably (BSD vs GNU stat).
loop_state_mode() {
	stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1" 2>/dev/null || printf '600'
}

# loop_state_set <state-file> <field> <value>
loop_state_set() {
	local file="${1-}" field="${2-}"

	if [ "$#" -lt 3 ]; then
		loop_state_die 64 "usage: loop_state_set <state-file> <field> <value>" || return
	fi
	if [ -z "$file" ]; then
		loop_state_die 2 "empty state-file path" || return
	fi
	if ! loop_state_valid_name "$field"; then
		loop_state_die 2 "invalid field name: ${field:-<empty>}" || return
	fi

	loop_state_lock "$file" || return

	# `|| rc=$?` is load-bearing, not style. The CLI path runs under `set -e`;
	# calling set_locked as an UNCHECKED command means a non-zero return (corrupt
	# state, failed write) exits the shell immediately — skipping the unlock below
	# and leaking the lock directory. Every later writer would then stall for the
	# full retry budget and fail, so one bad write would poison all future ones.
	# Making the call a checked command suppresses errexit and guarantees unlock.
	local rc=0
	loop_state_set_locked "$file" "$field" "$3" || rc=$?
	loop_state_unlock "$file"
	return "$rc"
}

# --- CLI -------------------------------------------------------------------

loop_state_main() {
	local verb="${1-}"

	case "$verb" in
	-h | --help)
		sed -n '2,45p' "$0"
		return 0
		;;
	'')
		loop_state_die 64 "usage: loop-state.sh {get|set} ..." || return
		;;
	esac

	shift

	case "$verb" in
	get)
		local raw=0
		if [ "${1-}" = "--raw" ]; then
			raw=1
			shift
		fi
		if [ "$#" -ne 2 ]; then
			loop_state_die 64 "usage: loop-state.sh get [--raw] <state-file> <field>" || return
		fi
		if [ "$raw" -eq 1 ]; then
			loop_state_get_value "$1" "$2"
		else
			loop_state_get "$1" "$2"
		fi
		;;
	set)
		if [ "$#" -ne 3 ]; then
			loop_state_die 64 "usage: loop-state.sh set <state-file> <field> <value>" || return
		fi
		loop_state_set "$1" "$2" "$3"
		;;
	*)
		loop_state_die 64 "unknown verb: $verb" || return
		;;
	esac
}

# Only run when executed, not when sourced by the test suite. `set -e` is scoped
# to execution so that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -euo pipefail
	loop_state_main "$@"
fi
