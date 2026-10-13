---
name: eque2-code-slidedeck
description: Builds a clickable HTML slidedeck from an interview. Use when the user says 'make a slidedeck', 'create a presentation', 'build slides', or 'update my deck'.
---

# Slidedeck

## Overview

This skill turns what a presenter knows into a clickable, self-contained HTML slidedeck. It interviews the user, writes a deck JSON that conforms to a closed schema, and compiles it with a hard-coded compiler. Act as a presentation designer who also reads code: one idea per slide, few words per bullet, code revealed in the order the speaker explains it. The output is `deck.json` (the editable source) and `deck.html` (one file that opens in any browser, offline except for Mermaid diagrams).

The agent never writes HTML or CSS. All markup comes from the compiler, so every deck behaves the same: → / Space / click advance, ← goes back, P opens the presenter view with notes and a timer, F goes fullscreen, `#/<slide>/<step>` deep-links, and Print / Save as PDF gives one page per slide.

## Conventions

- Bare paths (e.g. `assets/deck.schema.json`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{skills-root}` resolves to the directory that holds every installed skill.
- `{project-root}`-prefixed paths resolve from the project working directory.

The compiler is `node {skills-root}/eque2-code-slidedeck/scripts/slidedeck.mjs` (written `slidedeck` below). It needs Node 18+ and nothing else.

## On Activation

Load `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` if present; use `user_name`, `communication_language`, and `output_folder` (default `{project-root}/_bmad-output`). `--headless` / `-H` sets headless mode.

Each deck lives in `{output_folder}/slidedecks/<slug>/`: `deck.json`, `deck.html`, any local images, and `.decision-log.md`. Create the folder once the topic is clear; if it already exists, this is an update — read `.decision-log.md` and `deck.json` first and append a new dated session heading to the log. The decision log is canonical memory: audience, goal, structure choices, and every user override go there, so a later session can change the deck without re-interviewing.

## Interview

Open the floor: invite the user to share everything — topic, audience, the one thing the audience must leave with, time slot, an outline or notes, code they want to walk through, images, brand colour. Paths to files are welcome; read them. Then ask only for what is missing, and close with a soft "anything else?".

Code is where decks go wrong. For each code walkthrough, establish the starting code and the sequence of changes the speaker will talk through — each change becomes one click. Ask which lines to spotlight while the speaker talks.

Before writing JSON, show a slide-by-slide outline (layout, title, one line of content, the clicks) and get approval. A deck of N minutes rarely needs more than N slides.

## Write the deck

Read `assets/deck.schema.json` — it is the contract, and `slidedeck validate` rejects any key it does not list. `assets/example-deck.json` uses every feature; copy its shape. Write `deck.json` with `"$schema": "{skills-root}/eque2-code-slidedeck/assets/deck.schema.json"` so editors can check it.

Rules the schema cannot say:

- **Steps.** A slide opens showing everything that is not on-click. Each click reveals the next one-by-one bullet, the next block with `"onClick": true`, or the next code step — in document order, left column before right.
- **Diffs.** A code step's `diff` applies to the code as it is *after all earlier steps*, not to the original. Write a normal unified diff: `@@ -a,b +c,d @@`, then lines starting with space (context), `-`, or `+`. Copy context and `-` lines character-for-character, including indentation. Wrong `@@` line numbers are tolerated when the context is unique; wrong context is not.
- **Spotlights.** `highlight` line numbers count lines in the code as it is at that step (after that step's diff).
- **Images.** Paths are relative to `deck.json`; copy local images into the deck folder. `alt` is required on every image and diagram — describe what it shows, not "image".
- **Notes.** Put talking points in `notes`, not on the slide. Slides carry short phrases; notes carry sentences.

## Validate and build

```bash
slidedeck validate {deck-folder}/deck.json
slidedeck build {deck-folder}/deck.json
```

`validate` runs the whole compile, so it also catches diffs that do not apply, spotlight ranges past the last line, unknown languages, missing images, and duplicate slide ids. Each issue starts with its JSON path, e.g. `slides[3].block[0].steps[1]: hunk ... does not apply`. Fix and re-run; after three failed attempts on the same issue, stop and show the issue to the user. `build` writes `deck.html` next to `deck.json` (`-o <file>` to change).

## Review

Tell the user the path to `deck.html` and the keys (→, ←, P, F, Print). Iterate on their feedback by editing `deck.json` and rebuilding — never edit `deck.html`. When a change contradicts an earlier logged decision, say so before applying it, then log the override.

Finish with a decision-log audit: every entry is either reflected in the deck or explicitly set aside, and the user sees that accounting.

## Headless

Input is a brief (a file or inline text) or an existing `deck.json`. Skip the interview and the outline approval; log every assumption (audience, length, which code changes became steps) in `.decision-log.md`. Validate and build as above. Emit JSON only:

```json
{ "status": "complete", "deck": "<path to deck.html>", "source": "<path to deck.json>", "decision_log": "<path>" }
```

On failure after three fix attempts: `"status": "blocked"`, a one-line `"reason"`, and the paths that exist.
