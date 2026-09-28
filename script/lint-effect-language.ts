// Every package whose tsconfig registers @effect/language-service.
const root = import.meta.dir + "/.."
const candidates = await Array.fromAsync(new Bun.Glob("packages/*/tsconfig.json").scan({ cwd: root }))
const projects = (
  await Promise.all(
    candidates.map(async (project) =>
      (await Bun.file(`${root}/${project}`).text()).includes("@effect/language-service") ? project : undefined,
    ),
  )
)
  .filter((project) => project !== undefined)
  .sort()

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
