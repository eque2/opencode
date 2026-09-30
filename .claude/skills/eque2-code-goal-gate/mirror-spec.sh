#!/usr/bin/env bash
# mirror-spec.sh — copy the create-spec pipeline's artefacts into the goal
# folder and record where each copy came from (T4.6).
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/goal-folder.md §5
#
# Usage:
#   mirror-spec.sh in-place <goal-folder>
#   mirror-spec.sh mirror <goal-folder> <pipeline-dir>
#   mirror-spec.sh mirror <goal-folder> <slug>=<dir> [<slug>=<dir> ...]
#   mirror-spec.sh verify <goal-folder>
#   mirror-spec.sh --help
#
# IN-PLACE IS THE DEFAULT. Every document a prepare-goal run produces belongs in
# the goal folder and nowhere else, so the spec pipeline is pointed AT
# `X.goal/spec/` and writes there directly. `in-place` records that fact in the
# manifest: `spec/` IS the canonical source, there is no external directory, and
# `verify` has only to confirm the folder is non-empty. Nothing to copy, nothing
# to drift, nothing left behind in `_bmad-output/`.
#
# `mirror` remains for the case in-place cannot cover — a pipeline that owns an
# output path this feature may not redirect. It is the fallback, not the norm.
#
# ONE SOURCE OR MANY. A single-epic goal mirrors one pipeline directory into a
# flat `spec/`. A multi-epic goal mirrors each epic's pipeline into its own
# `spec/<slug>/` subtree, one `**Source \`slug\`:**` line per epic in the
# manifest, and `verify` drift-checks each subtree against its own source. The
# single-source form is unchanged; giving more than one source REQUIRES the
# labelled `<slug>=<dir>` form so the manifest can say which subtree each copy
# belongs to.
#
# RESOLVES R13. `spec.md` §A claimed the goal folder holds the spec, but the
# create-spec pipeline owns its own output path and this feature may not modify
# it — so "no artefact written outside the folder" was unachievable as written.
# The resolution is a MIRROR, not a move: the pipeline path stays authoritative
# for the build, and the copy is what makes the folder self-contained and
# movable.
#
# A MIRROR THAT LIES IS WORSE THAN NO MIRROR. Someone reading `X.goal/spec/`
# believes they are reading the spec the build ran against. So `verify` reports
# drift rather than repairing it silently: a copy that no longer matches its
# source is a question about which one is current, and answering it by
# overwriting destroys the evidence needed to answer it properly.
#
# Exit codes:
#   0   mirrored, or verified clean
#   2   invalid input (missing argument, not a goal folder)
#   3   the pipeline path does not exist, or produced nothing
#   4   drift: a mirrored copy differs from its source
#   5   filesystem failure
#   64  usage error

MS_MANIFEST="MANIFEST.md"

ms_die() {
	local code="$1"
	shift
	printf 'mirror-spec: %s\n' "$*" >&2
	return "$code"
}

ms_say() {
	printf 'mirror-spec: %s\n' "$*"
}

# ms_goal_folder <path> — an existing, writable goal folder.
ms_goal_folder() {
	local f="${1-}"

	if [ -z "$f" ]; then
		ms_die 2 "no goal folder given" || return
	fi
	if [ ! -d "$f" ]; then
		ms_die 2 "not a directory: $f" || return
	fi
	if [ ! -f "$f/goal.md" ] || [ ! -f "$f/ACs.md" ]; then
		ms_die 2 "not a prepared goal folder (goal.md and ACs.md are required): $f" || return
	fi
	if [ ! -w "$f" ]; then
		ms_die 5 "goal folder is not writable: $f" || return
	fi

	(cd -- "$f" && pwd -P)
}

# ms_slug_ok <slug> — a source label safe to use as a `spec/<slug>/` path
# component. Same allow-list the goal gate holds identities to: letters, digits,
# `.` `_` `-`, at most 128 bytes, and never `.` or `..` (which name the
# directory itself and its parent rather than a subtree).
ms_slug_ok() {
	local s="${1-}"
	[ -n "$s" ] || return 1
	[ "${#s}" -le 128 ] || return 1
	case "$s" in
	. | ..) return 1 ;;
	*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

# ms_runtime_artifact_rel <relative-path> — the runtime namespace created when
# the state-machine operates on the mirrored spec folder. These files are not
# pipeline artefacts and therefore cannot truthfully be compared with the
# canonical create-spec output. Keeping the list narrow is important: a normal
# source-authored `journal/foo.md` remains part of the mirror contract.
ms_runtime_artifact_rel() {
	case "${1-}" in
	state/* | .state-events.jsonl | .signer-key | .evidence-key | journal/task/* | journal/transcripts/*)
		return 0
		;;
	*) return 1 ;;
	esac
}

ms_mirror() {
	local folder dest count=0 rel total=0 n i j multi=0
	local -a slugs=() dirs=() resolved=()

	folder="$(ms_goal_folder "${1-}")" || return
	shift || true

	if [ "$#" -eq 0 ]; then
		ms_die 2 "no pipeline directory given" || return
	fi

	# Multi-source is triggered by the FIRST source being written `<slug>=<dir>`.
	# A bare path (the single-epic form) never matches, because a slug is only
	# `[A-Za-z0-9._-]` and a real pipeline path begins with `/` or `.`.
	case "${1}" in
	[A-Za-z0-9._-]*=*) multi=1 ;;
	esac

	local arg slug dir
	for arg in "$@"; do
		if [ "$multi" -eq 1 ]; then
			case "$arg" in
			[A-Za-z0-9._-]*=*) : ;;
			*) ms_die 2 "mixed source forms: '$arg' is not <slug>=<dir>. Give every source as <slug>=<dir>, or a single bare pipeline directory — a mixed manifest cannot say which subtree a bare copy belongs to." || return ;;
			esac
			slug="${arg%%=*}"
			dir="${arg#*=}"
			if ! ms_slug_ok "$slug"; then
				ms_die 2 "not a usable source label: '$slug' (allowed: letters, digits, . _ -; not . or ..)" || return
			fi
		else
			if [ "$#" -gt 1 ]; then
				ms_die 2 "more than one source given but the first is a bare path. Label every source as <slug>=<dir> for a multi-epic mirror." || return
			fi
			slug=""
			dir="$arg"
		fi
		slugs+=("$slug")
		dirs+=("$dir")
	done

	# Distinct subtrees, or the second source silently overwrites the first.
	if [ "$multi" -eq 1 ]; then
		for ((i = 0; i < ${#slugs[@]}; i++)); do
			for ((j = i + 1; j < ${#slugs[@]}; j++)); do
				if [ "${slugs[i]}" = "${slugs[j]}" ]; then
					ms_die 2 "duplicate source label: '${slugs[i]}'. Each source needs a distinct spec/<slug>/ subtree." || return
				fi
			done
		done
	fi

	# Resolve and validate EVERY source before copying anything: a mirror that
	# fails halfway leaves spec/ holding some epics and not others, which reads
	# as a complete mirror of a smaller goal.
	for ((n = 0; n < ${#dirs[@]}; n++)); do
		dir="${dirs[n]}"
		if [ -z "$dir" ]; then
			ms_die 2 "empty pipeline directory for source '${slugs[n]:-<single>}'" || return
		fi
		if [ ! -d "$dir" ]; then
			ms_die 3 "the pipeline path does not exist or is not a directory: $dir. The mirror is REPORTED as impossible rather than written empty — an empty spec/ reads as 'the pipeline produced nothing', which is a different claim." || return
		fi
		# Readability against the path the caller gave, before resolution: a
		# resolve-first order failed inside the command substitution and left
		# the diagnostic naming neither the problem nor the path.
		if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
			ms_die 3 "the pipeline directory is not readable: $dir" || return
		fi
		local rdir
		if ! rdir="$(cd -- "$dir" 2>/dev/null && pwd -P)" || [ -z "$rdir" ]; then
			ms_die 3 "cannot enter the pipeline directory: $dir" || return
		fi
		# The pipeline produced nothing. An empty mirror plus a manifest claiming
		# a source is a false record, so this refuses instead.
		count=0
		while IFS= read -r src; do
			[ -n "$src" ] || continue
			rel="${src#"$rdir"/}"
			ms_runtime_artifact_rel "$rel" && continue
			count=$((count + 1))
		done < <(find "$rdir" -type f 2>/dev/null | LC_ALL=C sort)
		if [ "$count" = "0" ]; then
			ms_die 3 "the pipeline directory holds no mirrorable specification files: $rdir. Runtime state is excluded; nothing was mirrored and no manifest was written." || return
		fi
		resolved+=("$rdir")
		total=$((total + count))
	done

	dest="$folder/spec"
	if [ -e "$dest" ] && [ ! -d "$dest" ]; then
		ms_die 5 "collision: $dest exists and is not a directory" || return
	fi

	# Replaced wholesale rather than merged: a merge leaves artefacts from a
	# previous pipeline run sitting beside the current ones, indistinguishable.
	rm -rf -- "$dest" 2>/dev/null
	if ! mkdir -p -- "$dest" 2>/dev/null; then
		ms_die 5 "cannot create the mirror directory: $dest" || return
	fi
	for ((n = 0; n < ${#resolved[@]}; n++)); do
		local sub="$dest"
		[ -n "${slugs[n]}" ] && sub="$dest/${slugs[n]}"
		if ! mkdir -p -- "$sub" 2>/dev/null; then
			ms_die 5 "cannot create the mirror subdirectory: $sub" || return
		fi
		while IFS= read -r src; do
			[ -n "$src" ] || continue
			rel="${src#"${resolved[n]}"/}"
			ms_runtime_artifact_rel "$rel" && continue
			local target="$sub/$rel"
			if ! mkdir -p -- "$(dirname -- "$target")" 2>/dev/null || ! cp -p -- "$src" "$target" 2>/dev/null; then
				ms_die 5 "cannot copy the pipeline artefact into: $target" || return
			fi
		done < <(find "${resolved[n]}" -type f 2>/dev/null | LC_ALL=C sort)
	done

	# The manifest is the ONE place an outward-pointing path is allowed to live
	# (goal-folder.md §4): recorded as data, never embedded as a link in an
	# artefact, so the folder stays movable and the external coupling stays
	# visible in one place.
	{
		printf '# MANIFEST\n\n'
		printf 'Mirrored artefacts and the canonical path each copy came from.\n\n'
		printf 'The pipeline path(s) below stay AUTHORITATIVE for the build. The copies in\n'
		# shellcheck disable=SC2016  # literal markdown written to the manifest
		printf '`spec/` exist so this folder is self-contained and movable; they are not\n'
		printf 'the build input. Where a copy and its source disagree, the source wins and\n'
		printf 'the disagreement is a question to answer, not a copy to overwrite —\n'
		# shellcheck disable=SC2016  # literal markdown written to the manifest
		printf 'run `mirror-spec.sh verify` to see it.\n\n'
		if [ "$multi" -eq 1 ]; then
			for ((n = 0; n < ${#resolved[@]}; n++)); do
				# shellcheck disable=SC2016  # literal markdown written to the manifest
				printf '**Source `%s`:** `%s`\n' "${slugs[n]}" "${resolved[n]}"
			done
		else
			# shellcheck disable=SC2016  # literal markdown written to the manifest
			printf '**Source:** `%s`\n' "${resolved[0]}"
		fi
		printf '**Mirrored:** %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
		printf '| Mirrored copy | Canonical source |\n'
		printf '|---|---|\n'
		for ((n = 0; n < ${#resolved[@]}; n++)); do
			local prefix=""
			[ -n "${slugs[n]}" ] && prefix="${slugs[n]}/"
			find "${resolved[n]}" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r src; do
				rel="${src#"${resolved[n]}"/}"
				ms_runtime_artifact_rel "$rel" && continue
				# shellcheck disable=SC2016  # literal markdown written to the manifest
				printf '| `spec/%s%s` | `%s` |\n' "$prefix" "$rel" "$src"
			done
		done
	} >"$folder/$MS_MANIFEST" || {
		ms_die 5 "cannot write the manifest: $folder/$MS_MANIFEST" || return
	}

	if [ "$multi" -eq 1 ]; then
		ms_say "mirrored $total file(s) from ${#resolved[@]} source(s) into $dest"
	else
		ms_say "mirrored $total file(s) from ${resolved[0]} into $dest"
	fi
	ms_say "manifest: $folder/$MS_MANIFEST"
}

MS_INPLACE_MARK='**Authored:** in place'

# ms_in_place <goal-folder> — record that `spec/` IS the canonical source.
#
# The spec pipeline was pointed at `X.goal/spec/` and wrote there, so there is
# no external directory to copy from and no provenance to record beyond "here".
# The manifest still gets written, because `pursue-goal` refuses a `spec/` with
# no manifest — a spec whose origin nothing states is exactly the thing the
# manifest exists to prevent, and "it was authored here" is a provenance claim
# like any other.
ms_in_place() {
	local folder dest count

	folder="$(ms_goal_folder "${1-}")" || return
	dest="$folder/spec"

	if [ ! -d "$dest" ]; then
		ms_die 3 "no $dest — the spec pipeline was supposed to write there. An in-place manifest over an absent spec/ would assert a spec that does not exist." || return
	fi
	count="$(find "$dest" -type f 2>/dev/null | wc -l | tr -d ' ')"
	if [ "${count:-0}" -eq 0 ]; then
		ms_die 3 "$dest holds no files. A pipeline that produced nothing is reported as exactly that, never as an empty spec/ with a manifest claiming one." || return
	fi

	{
		printf '# MANIFEST\n\n'
		# shellcheck disable=SC2016  # literal markdown written to the manifest
		printf '%s — `spec/` IS the canonical source for this workstream.\n' "$MS_INPLACE_MARK"
		printf 'There is no external pipeline directory: the spec was produced directly in\n'
		printf 'this folder, so every document the run produced lives inside it and nothing\n'
		printf 'was left behind elsewhere. Nothing to copy, nothing to drift.\n\n'
		printf '**Recorded:** %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
		printf '**Files:** %s\n' "$count"
	} >"$folder/$MS_MANIFEST" || {
		ms_die 5 "cannot write the manifest: $folder/$MS_MANIFEST" || return
	}

	ms_say "recorded $count in-place spec file(s) in $dest"
	ms_say "manifest: $folder/$MS_MANIFEST"
}

# ms_verify <goal-folder> — every mirrored copy still matches its source.
#
# One `**Source:**` line maps the whole `spec/` tree to one source (single
# epic). N `**Source \`slug\`:**` lines each map `spec/<slug>/` to their own
# source (multi-epic). The two forms are mutually exclusive; a manifest carrying
# both is ambiguous and refused. Everything downstream works off one uniform
# list of (prefix, source) pairs, so the single case is just the multi case with
# an empty prefix.
ms_verify() {
	local folder manifest drift=0 checked=0 rel src copy single line s p i k
	local -a mslugs=() msrcs=() prefixes=() sources=()

	folder="$(ms_goal_folder "${1-}")" || return
	manifest="$folder/$MS_MANIFEST"

	if [ ! -f "$manifest" ]; then
		ms_die 2 "no manifest at $manifest — nothing records where the mirror came from, so it cannot be verified." || return
	fi
	if [ ! -s "$manifest" ]; then
		ms_die 2 "the manifest is empty: $manifest. An empty manifest is invalid — it asserts a mirror with no provenance." || return
	fi

	# shellcheck disable=SC2016  # the manifest sed pattern is a literal, not an expansion
	single="$(sed -n 's/^\*\*Source:\*\* `\(.*\)`$/\1/p' "$manifest" | head -1)"

	# In-place: `spec/` is its own source, so there is no copy→source comparison
	# to make. All verify owes the caller is that the spec is actually there —
	# an in-place manifest over an empty spec/ is the same lie an empty mirror
	# would be. Checked BEFORE the source forms so a manifest that claims both
	# in-place and an external source is refused rather than silently preferred.
	if grep -qF "$MS_INPLACE_MARK" "$manifest" 2>/dev/null; then
		if [ -n "$single" ] || grep -q '^\*\*Source `' "$manifest" 2>/dev/null; then
			ms_die 2 "the manifest claims the spec was authored in place AND names an external source; it cannot be both. Re-record it." || return
		fi
		if [ ! -d "$folder/spec" ]; then
			ms_die 3 "the manifest records an in-place spec but there is no $folder/spec." || return
		fi
		checked="$(find "$folder/spec" -type f 2>/dev/null | wc -l | tr -d ' ')"
		if [ "${checked:-0}" -eq 0 ]; then
			ms_die 2 "the manifest records an in-place spec but $folder/spec holds no files." || return
		fi
		ms_say "verified $checked in-place spec file(s) — spec/ is the canonical source, nothing to drift"
		return 0
	fi

	# Labelled blocks: **Source `slug`:** `path`
	while IFS= read -r line; do
		# shellcheck disable=SC2016  # literal sed pattern
		s="$(printf '%s' "$line" | sed -n 's/^\*\*Source `\([^`]*\)`:\*\* `.*`$/\1/p')"
		[ -n "$s" ] || continue
		# shellcheck disable=SC2016  # literal sed pattern
		p="$(printf '%s' "$line" | sed -n 's/^\*\*Source `[^`]*`:\*\* `\(.*\)`$/\1/p')"
		mslugs+=("$s")
		msrcs+=("$p")
	done <"$manifest"

	if [ -n "$single" ] && [ "${#mslugs[@]}" -gt 0 ]; then
		ms_die 2 "the manifest mixes a single **Source:** with labelled **Source \`slug\`:** blocks; it cannot be both. Re-mirror." || return
	fi
	if [ -z "$single" ] && [ "${#mslugs[@]}" -eq 0 ]; then
		ms_die 2 "the manifest records no source path: $manifest" || return
	fi

	# Uniform (prefix, source) list. Single: one empty-prefix pair covering all
	# of spec/. Multi: one `<slug>/`-prefixed pair per labelled block.
	if [ -n "$single" ]; then
		prefixes+=("")
		sources+=("$single")
	else
		for ((k = 0; k < ${#mslugs[@]}; k++)); do
			if ! ms_slug_ok "${mslugs[k]}"; then
				ms_die 2 "the manifest names an unusable source label: '${mslugs[k]}'" || return
			fi
			prefixes+=("${mslugs[k]}/")
			sources+=("${msrcs[k]}")
		done
	fi

	for ((i = 0; i < ${#sources[@]}; i++)); do
		if [ ! -d "${sources[i]}" ]; then
			ms_die 3 "the canonical source no longer exists: ${sources[i]}. The mirror cannot be verified against it; this is reported, not passed over." || return
		fi
	done

	# Process substitution, not a here-doc: `<<EOF\n$(find …)\nEOF` always
	# contains at least one line, so an EMPTY mirror still entered the loop once
	# with copy="" and reported a phantom DRIFT — exit 4 for a condition the
	# header documents as exit 2, and the checked-eq-0 branch below could never
	# run at all.
	while IFS= read -r copy; do
		[ -n "$copy" ] || continue
		rel="${copy#"$folder"/spec/}"
		# Which declared subtree does this copy belong to? An empty prefix
		# (single-source) matches everything; otherwise the copy must sit under
		# one `<slug>/`. A copy under no declared subtree is sourceless drift —
		# in multi mode that catches a stray file dropped at the top of spec/.
		local matched=-1
		for ((i = 0; i < ${#prefixes[@]}; i++)); do
			if [ -z "${prefixes[i]}" ]; then
				matched=$i
				break
			fi
			case "$rel" in
			"${prefixes[i]}"*)
				matched=$i
				break
				;;
			esac
		done
		if [ "$matched" -lt 0 ]; then
			printf 'mirror-spec: DRIFT — mirrored copy is under no declared source subtree: spec/%s\n' "$rel" >&2
			drift=$((drift + 1))
			continue
		fi
		local source_rel="${rel#"${prefixes[matched]}"}"
		ms_runtime_artifact_rel "$source_rel" && continue
		checked=$((checked + 1))
		src="${sources[matched]}/$source_rel"
		if [ ! -f "$src" ]; then
			printf 'mirror-spec: DRIFT — mirrored copy has no source: spec/%s\n' "$rel" >&2
			drift=$((drift + 1))
		elif ! cmp -s -- "$copy" "$src"; then
			printf 'mirror-spec: DRIFT — spec/%s differs from %s\n' "$rel" "$src" >&2
			drift=$((drift + 1))
		fi
	done < <(find "$folder/spec" -type f 2>/dev/null | LC_ALL=C sort)

	if [ "$checked" -eq 0 ]; then
		ms_die 2 "the mirror holds no files, but a manifest claims one: $manifest" || return
	fi

	# The OTHER direction, per source. Walking copy→source alone cannot see a
	# file the pipeline has since ADDED, so a materially incomplete mirror
	# reported "no drift" — the worst answer for a thing whose whole purpose is
	# to be trusted as a faithful copy.
	for ((i = 0; i < ${#sources[@]}; i++)); do
		while IFS= read -r src; do
			[ -n "$src" ] || continue
			rel="${src#"${sources[i]}"/}"
			ms_runtime_artifact_rel "$rel" && continue
			if [ ! -f "$folder/spec/${prefixes[i]}$rel" ]; then
				printf 'mirror-spec: DRIFT — the source has a file the mirror does not: %s%s\n' "${prefixes[i]}" "$rel" >&2
				drift=$((drift + 1))
			fi
		done < <(find "${sources[i]}" -type f 2>/dev/null | LC_ALL=C sort)
	done

	if [ "$drift" -gt 0 ]; then
		ms_die 4 "$drift of $checked mirrored file(s) no longer match their source. The source is authoritative; decide which is current rather than overwriting either." || return
	fi

	ms_say "verified $checked mirrored file(s) against ${#sources[@]} source(s) — no drift"
}

ms_main() {
	local verb="${1-}"

	case "$verb" in
	-h | --help | '')
		sed -n '2,51p' "$0"
		return 0
		;;
	esac
	shift

	case "$verb" in
	in-place) ms_in_place "${1-}" ;;
	mirror) ms_mirror "$@" ;;
	verify) ms_verify "${1-}" ;;
	*) ms_die 64 "unknown verb: $verb (known: in-place, mirror, verify)" ;;
	esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	ms_main "$@"
	exit $?
fi
