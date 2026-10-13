# Mint-verb policy clauses (canonical snippet)

The ONE canonical source of the verifier-only-minting policy clauses
(SPEC-verifier-only-minting, CAP-7). Every policy carrier embeds BOTH clauses
verbatim; `scripts/audit-policy-clauses.py` verifies each carrier against
this file with whitespace/quote-normalized matching. Edit here first, then
re-land in every carrier — a paraphrased or weakened clause is an audit FAIL.

**Clause A — never-probe:** Privileged verbs (`verdict`, `force-reset`,
`verification-reset`) are never invoked to see what happens, to discover
flags, or to test validation. Discovery is `--help` only. Sole exception:
inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode
(the sanctioned test path this project's own suite uses).

**Clause B — anti-reclassification:** Running a mint verb IS minting,
whatever you call it — probe, test, dry run, experiment. There is no intent
exception outside the sanctioned canary mode above; the CLI records the
invocation as an attempt regardless of outcome.
