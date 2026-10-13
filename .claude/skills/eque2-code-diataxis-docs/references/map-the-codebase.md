# Map the Codebase

Goal: a complete page map — what to document, which mode each page is, where it lives, and
which code it describes — with publishable material cleanly separated from working notes.
Read `references/diataxis.md` first if you have not this run.

## Sweep

The code is the ground truth; existing docs may be stale or partial.

- **Existing docs** — `{docs_root}`, the README, CONTRIBUTING, ADRs, and doc comments. They
  are the best raw material, but verify every claim against the code. Where they disagree,
  the code wins; note the discrepancy in the decision log.
- **Public surface** — everything a reader can touch: entry points, CLI commands and flags,
  exported API, HTTP/RPC endpoints, events, configuration files, environment variables,
  data models and schemas, error codes, deploy and run targets, extension points.
- **Repo facts** — manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …),
  CI workflows, container files, the changelog. They fix names, versions, and commands.

On a large codebase, keep your own context lean: split the tree into slices and hand each
slice to a read-only subagent (Explore). Ask each one to return ONLY a JSON array of surface
items — `{"kind", "name", "location", "summary", "reader_relevance"}` — and no other output.
Without subagents, sweep the slices one at a time.

## Keep, lift, or drop

- **Keep** durable material a reader would want: overviews, guides, references, rationale.
- **Lift** a useful kernel out of a working note (a threat model in an incident write-up, a
  design argument in a PR thread) and rewrite it as a proper page. Never copy the note.
- **Drop** working material — incident notes, backlog and idea files, scratch reports,
  generated analyses — and machinery the reader never touches (steps a setup script already
  does for them, internal detail with no effect on what the reader does). If a page would
  not change a reader's actions or understanding, it does not earn a page.

Record every exclusion and its reason in the decision log. Surface genuinely borderline calls
to the user; in headless mode, record the assumption.

## Decide the audience

Name the **primary audience** first: the users of a library, CLI, or service; or the
developers and operators of an application that has no outside users. The four modes serve
the primary audience. When the primary audience is outside users, material that only
matters to people working *inside* the repository (build, release, repo layout, internal
machinery) goes in a flat `contributing/` section with `doc-type: contributing` — no mode
sub-structure. When the developers *are* the primary audience, their material gets the full
four-mode treatment and there is no `contributing/` section.

Name the **flagship**: the entry point people reach for first. It gets its own page and a
section on the landing page — never bury it in an inventory.

## Build the map

One entry per page: title, `doc-type`, path, `sources` (the code paths the page documents,
relative to the project root), and related pages (by path). Paths are
`<section>/<kebab-slug>.md` under `{docs_root}`, with sections `tutorials/`, `how-to/`,
`reference/`, `explanation/`, and optionally `contributing/`; a large reference may nest
one level (`reference/cli/<command>.md`). **Fix every path now** — authors link to planned
paths before the target pages exist, so a path that changes later breaks links.

One source often yields several pages in different modes. Split a sprawling topic into
well-scoped pages rather than straining one page's contract. Reference mirrors the code's
own structure.

### Exhaustive (default)

The map is complete when:

- every item of the public surface appears in a reference page;
- every task a reader repeatedly does has a how-to;
- at least one tutorial takes a newcomer from nothing to a first working result;
- every non-obvious design decision the code embodies has an explanation.

### Curated (`--curated[=N]`)

Build the full map anyway, then rank each page by reader value: how many readers need it,
times how much its absence hurts. The usual winners are the first-run tutorial, how-tos for
the two to four most frequent tasks, reference for the entry point people look up most
(the main CLI, API, or config file), and the one or two explanations that make the
architecture make sense. Take the top N, keeping at least one page per section when the
codebase supports it. The rest of the map becomes the **deferred** list, ranked, in the
decision log — a later `update --exhaustive` writes it.
