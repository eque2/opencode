const checks = [
  ["Oxlint", [process.execPath, "run", "lint:oxlint"]],
  ["Effect ESLint", [process.execPath, "run", "lint:effect-eslint"]],
  ["Effect language service", [process.execPath, "run", "lint:effect-language"]],
] as const

let status = 0

for (const [name, command] of checks) {
  console.log(`\n=== ${name} ===`)
  const child = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exit = await child.exited
  if (exit !== 0) status = exit
}

process.exit(status)
