const projects = ["packages/effect-sqlite-node/tsconfig.json", "packages/protocol/tsconfig.json"] as const

let status = 0

for (const project of projects) {
  console.log(`\n=== ${project} ===`)
  const child = Bun.spawn(
    [
      "node",
      "node_modules/@effect/language-service/cli.js",
      "diagnostics",
      "--project",
      project,
      "--format",
      "text",
      "--severity",
      "error,warning",
      "--strict",
    ],
    {
      cwd: import.meta.dir + "/..",
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const exit = await child.exited
  if (exit !== 0) status = exit
}

process.exit(status)
