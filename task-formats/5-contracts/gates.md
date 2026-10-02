# Gates

Each gate is an obligation judged by the runner: the command exits 0.

| Gate | Check | Command | Needs |
| --- | --- | --- | --- |
| BUILD-2 | Type check passes | `pnpm nx run-many -t typecheck -p ui,api,media,media-mcp,contracts,db` | Node 22 |
| BUILD-4 | Tests pass | `pnpm nx run-many -t test-ci -p ui,api,media,media-mcp,contracts,db` | Node 22; `test-ci`, not `test`, because `nx test` hangs locally |
