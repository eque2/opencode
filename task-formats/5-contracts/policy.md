# Verification policy

Applies to every obligation unless a contract says otherwise.

- **red-first** — A failing test for each case lands before the change that makes it pass.
- **proof-binding** — A test proves an id when its title starts with `[<id>]`, for example `[T2.1.c4]` or `[S25]`. File paths are hints; the tag is the binding.
- **structural** — Every case id has at least one tagged test; each tagged test ran and passed at the task's final commit; the task's commits change only the files it declares, plus tests.
- **review** — One independent review of each parent task's combined diff once all its subtasks are trusted. Fixes land in their own commits.
- **trust** — An independent verifier, never the builder, judges that every case and every scenario step is proved by an assertion that would fail if the behaviour broke. A rejection returns the task with reasons.
- **acceptance** — A scenario is judged once every task that supports it is trusted, by running the tests tagged with its id.
- **evidence** — Runner exit code, pass and fail counts, run id and commit. Scenarios: the signed reporter evidence of that run.
- **budgets** — 10 build attempts per task; 3 retries per scenario or gate.

## Judges

- **runner** — executes the proof (a test run or a gate command) and reads the exit code and counts.
- **verifier** — an independent agent that judges whether the assertion behind a passing test would fail if the obligation were broken.
- **reviewer** — an independent code review of the diff.
- **engine** — a mechanical check, such as a path that must not change in the task's commits.
