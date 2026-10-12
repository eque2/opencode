# Golden model — the reference checker's behaviour, frozen as data

The TypeScript task parser (`packages/opencode/src/task/`) is held to parity with the reference checker
`check_blend.py`. The checker is a Python script that is not in this repository. These files record what it does,
so the parity tests need no Python.

| File | What it holds |
|---|---|
| `provider-ordering-admin.model.json` | `check_blend.py --json` on `../provider-ordering-admin.spec`: the README's parse target, unit hashes included. The TypeScript model must equal it byte for byte. |
| `provider-ordering-admin.check.txt` | The plain run: the summary line on stdout, then the R12 note on stderr. |
| `negative/<nn>-<rule>-<slug>/` | One defect each, from the checker's mutation test. |

## A negative case

- `case.json` — `rule` (the rule the defect breaks), `name`, `exit` (always 1), and `delete` (paths under the spec
  folder to remove; a renamed folder appears as its old path here and its new files under `files/`).
- `files/` — every file the defect adds or changes, at its path under the spec folder.
- `expected.txt` — the checker's stdout: one `R<n> <path>: <message>` line per failure.

To rebuild the failing spec: copy `../provider-ordering-admin.spec`, delete each `delete` path, then copy `files/`
over it. The generator replayed every case this way and got `expected.txt` back exactly.

R12 has no case here: it is a runtime rule (the engine checks the state store) and the static checker only notes it.
