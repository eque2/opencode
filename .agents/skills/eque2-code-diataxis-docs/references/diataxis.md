# The Diataxis Framework

Diataxis organises documentation by the reader's **need at the moment of reading**, not by
the structure of the software. There are four modes, and every page is deliberately *one*
of them. Mixing modes on one page is the most common documentation failure: a tutorial that
keeps stopping to explain, or a reference that tries to teach, serves neither reader.

The two axes:

- **Action ↔ Cognition** — is the reader *doing* or *thinking*?
- **Acquisition ↔ Application** — is the reader *studying* (learning) or *working* (using)?

|                          | Action        | Cognition   |
| ------------------------ | ------------- | ----------- |
| **Acquisition** (study)  | Tutorials     | Explanation |
| **Application** (work)   | How-to guides | Reference   |

To place a page, ask both questions: does it inform action or cognition, and does it serve
study or work? The answers name the mode.

**Internal lens only.** The framework shapes how the set is organised. Reader-facing pages
never name it and never link to diataxis.fr — readers consume well-organised docs, not a
methodology. Plain descriptors such as "learning-oriented" on an index page are fine.

## Tutorials — learning-oriented (`tutorials/`)

A lesson that takes a newcomer through a meaningful experience that is guaranteed to
succeed. The author is a teacher; the reader does not yet know what they need to know.

- **Contract:** the reader follows along and it *works*, every time, on a clean machine.
- **Do:** one complete path from nothing to a visible result; concrete steps; tell the reader
  what they should see after each step; minimum explanation.
- **Don't:** offer alternatives, justify decisions, or cover edge cases — link onward instead.
- **Shape:** title naming the outcome ("Build your first …") → what you will build →
  prerequisites → numbered steps, each with its expected output → what you learned → next
  steps (links to how-tos and explanation).

## How-to guides — task-oriented (`how-to/`)

A recipe that directs a competent reader to a goal they already have.

- **Contract:** solves a real problem the reader has, named as a goal in the title.
- **Do:** assume competence; give a clear sequence; cover the real-world variations
  ("if you also need X"); stop when the goal is met.
- **Don't:** teach concepts or explain the machinery — link to explanation and reference.
- **Shape:** "How to …" title → when you need this → prerequisites → steps → variations →
  related reference.

## Reference — information-oriented (`reference/`)

An authoritative description of the machinery: APIs, commands, configuration, schemas,
data models, states, errors. The reader consults it while working and must trust it.

- **Contract:** accurate, complete, consistent; structured to mirror the code, so it is
  predictable to navigate.
- **Do:** describe and only describe; cover every item; state types, defaults, constraints,
  return shapes, and errors; use tables for parameters, fields, and states; give a short
  usage example per item.
- **Don't:** instruct or explain *why*. Neutral facts only.
- **Shape:** one page per command group, module, config file, or schema → a summary table →
  one consistent block per item.

## Explanation — understanding-oriented (`explanation/`)

Discursive prose that gives context: background, design rationale, trade-offs, history,
how the parts fit together. Read away from the keyboard.

- **Contract:** deepens understanding; makes connections; explains *why*.
- **Do:** discuss design decisions and their reasons; compare the approaches that were
  considered and rejected; admit trade-offs and opinions.
- **Don't:** give step-by-step instructions or exhaustive parameter lists.
- **Shape:** a title naming the topic ("About …", "Why …") → the question it answers →
  discussion → consequences for the reader → related pages.

## Applying the framework

- **One mode per page.** When a draft drifts, split it and cross-link.
- **Cross-link across modes, don't merge them.** A how-to links to the reference it uses and
  to the explanation behind it; a tutorial ends with links to both.
- **Map before writing.** Every code area maps to one or more pages, often in several modes
  (a state machine → a reference catalogue *and* an explanation of why it exists).

Canonical source: https://diataxis.fr — consult it for edge cases when it is reachable;
this file is enough to work from offline.
