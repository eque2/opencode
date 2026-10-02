# Format 5 — contracts with numbered obligations

```
5-contracts/
  T2.contract.md                    the parent contract: its parts and the review
  T2.1.contract.md … T2.6.contract.md
  acceptance.contract.md            each scenario as one obligation
  gates.md · policy.md · refs.md
```

## The idea

Every normative statement is an obligation with an id, a proof and a judge. Verification is "evaluate every
obligation", and state is "the result of each obligation", stored elsewhere under the obligation id. T2's six
contracts hold 60 obligations.

| Section | Ids | Meaning |
| --- | --- | --- |
| `Ensures` | `T2.1.c1` … | what must be true after the work — the test cases |
| `Preserves` | `T2.1.p1` … | what must still be true — invariants, compatibility |
| `Forbids` | `T2.1.f1` … | what the work must not do |
| `Requires` | task ids | preconditions — the contracts that must be trusted first |

Each obligation names its proof (`the test tagged [T2.1.c4]`, `gate BUILD-2`, `path unchanged in this task's
commits`, `review`) and its judge (`runner`, `verifier`, `reviewer`, `engine`). See `policy.md`.

`Approach` is guidance only: nothing in it is judged, so the builder may ignore advice but not an obligation.

## Grammar

- YAML front matter: `contract`, `title`, `part-of`, `after`, `refs`.
- Fixed `##` sections as above. Each obligation is a list item `**<id>** — <text>` with indented `proof:` and
  `judge:` sub-items.

## Where verification lives

It is the file. There is no separate verification artefact: the contract is the verification.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts. Here state is per obligation: `T2.2.c6 → passed, run 41, commit 9f1c…, verifier trusted`.

## Strengths

- Every claim is addressable, so a verdict can say exactly which obligation failed and why.
- Proof kinds beyond tests are first class: a forbidden file is checked by a diff, an invariant by a gate.
- Partial progress is precise: "54 of 60 obligations proved" says more than "in progress".

## Weaknesses

- The most verbose format, and the most formal to write.
- Prose context is squeezed into `Approach`, which is easy to under-write.
- Authors must classify each statement (ensure, preserve or forbid), which is sometimes a judgment call.
