import subprocess, sys
SP=sys.argv[1]
base=open(SP+"/wip/shared.base.tsx").read()
M=[
 ("failure plural", 'lines.length === 1 ? "failure" : "failures"', '"failures"'),
 ("no note", 'note: "The run keeps the plan it loaded.",', 'note: "",'),
 ("waits after end", 'if (tagged(status.run, "ended")) return []', ''),
 ("waits trusted too", '.filter((id) => status.outside?.[id]?.state === "untrusted")', ''),
 ("waits no sort", '    .sort(byId)\n}', '}'),
 ("outside line words", 'waiting on ${id} (outside) — run /task trust ${id}', 'waiting on ${id} — run /task trust ${id}'),
 ("stopped all rows", 'rows(status).filter((row) => tagged(row.task, "stopped"))', 'rows(status).filter((row) => row.task.state !== "running")'),
 ("stopped one key per state", '`${row.task.state}\\n${row.task.reason ?? ""}`)', 'row.task.state)'),
 ("stopped ids unsorted", 'ids: members.map((row) => row.id).sort(byId),', 'ids: members.map((row) => row.id).reverse(),'),
 ("stopped no group sort", '.toSorted((a, b) => a.group - b.group)', ''),
 ("stopped blocked flag", 'blocked: tagged(first, "blocked"),', 'blocked: false,'),
 ("fit off by one", 'if (piece.text.length < acc.room)', 'if (piece.text.length <= acc.room + 1)'),
 ("ids no +N", '...(ids.more > 0 ? [{ text: `, +${ids.more}`, tone: "muted" as const }] : []),', ''),
 ("+N not muted", '`, +${ids.more}`, tone: "muted" as const', '`, +${ids.more}`, tone: "text" as const'),
 ("short at 20", 'const short = width < 30', 'const short = width < 20'),
 ("blocked reason muted", 'line.reason}`, tone: "warning" as const }]', 'line.reason}`, tone: "muted" as const }]'),
 ("reason not muted", '{ text: ` — ${line.reason}`, tone: "muted" as const }', '{ text: ` — ${line.reason}`, tone: "text" as const }'),
 ("ids not toned", '{ text: `${glyph(line.state)} ${ids.text}`, tone: tone(line.state) }', '{ text: `${glyph(line.state)} ${ids.text}`, tone: "text" }'),
 ("entries unsorted", 'return Object.keys(status.scenarios)\n    .sort(byId)', 'return Object.keys(status.scenarios)'),
 ("no outside marker", '...(outside.includes(id) ? [{ text: " (outside)", tone: "warning" as const }] : []),', ''),
 ("outside marker muted", '{ text: " (outside)", tone: "warning" as const }', '{ text: " (outside)", tone: "muted" as const }'),
 ("no not run prefix", '? [{ text: "not run: ", tone: "muted" }, ...waits]', '? waits'),
 ("parked not run", '? [{ text: "not run", tone: "muted" }]', '? [{ text: label(scenario.state), tone: "muted" }]'),
 ("blocked label muted", '[{ text: scenario.reason ?? label(scenario.state), tone: "warning" }]', '[{ text: scenario.reason ?? label(scenario.state), tone: "muted" }]'),
 ("blocked reason under", 'tagged(scenario, "stopped") && !tagged(scenario, "blocked") ?', 'tagged(scenario, "stopped") ?'),
 ("no reason under", '(scenario.reason ?? "") : "",', '"" : "",'),
 ("heading counts all", 'all.filter((scenario) => tagged(scenario, "ended") && !tagged(scenario, "stopped")).length', 'all.length'),
 ("heading none text", 'return "SCENARIOS none in this run"', 'return "SCENARIOS 0"'),
 ("title min 6", 'export const TITLE_MIN = 12', 'export const TITLE_MIN = 6'),
 ("waits never cut", 'const labelRoom = entry.waits\n', 'const labelRoom = false\n'),
 ("label cut always", ': labelLength\n', ': Math.min(labelLength, Math.max(0, room - TITLE_MIN))\n'),
 ("reason 3 lines", 'const shown = lines.slice(0, 2)', 'const shown = lines.slice(0, 3)'),
 ("reason indent 2", 'return shown.map((line) => `    ${cut(line, room)}`)', 'return shown.map((line) => `  ${cut(line, room)}`)'),
 ("reason no ellipsis", 'if (lines.length > 2) shown[1] = cut(`${shown[1]} ${lines.slice(2).join(" ")}`, room)', ''),
 ("columns from 100", 'if (width < 80) return [items]', 'if (width < 100) return [items]'),
 ("columns row first", 'return [items.slice(0, half), items.slice(half)]', 'return [items.filter((_, i) => i % 2 === 0), items.filter((_, i) => i % 2 === 1)]'),
 ("page full height", 'box?.scrollBy(by * Math.max(1, box.height - 1))', 'box?.scrollBy(by * box.height)'),
 ("no click select", 'onClick={() => props.view.select(line.ids[0])}', ''),
 ("click last id", 'props.view.select(line.ids[0])', 'props.view.select(line.ids.at(-1) ?? "")'),
 ("region not scroll", '<scrollbox\n', '<box\n'),
 ("rows ignore height", 'Math.min(props.height, regionRows(current, props.width))', 'regionRows(current, props.width)'),
 ("no warning rendered", '<Show when={warningOf(current())}>', '<Show when={false && warningOf(current())}>'),
 ("no waits rendered", '<For each={outsideWaits(current()).flatMap((id) => wrap(outsideLine(id), props.width))}>', '<For each={[] as string[]}>'),
 ("stopped count lines", 'stoppedLines(current()).reduce((sum, line) => sum + line.ids.length, 0)', 'stoppedLines(current()).length'),
 ("no reason lines rendered", '<For each={entry.reason ? reasonLines(entry.reason, cells()) : []}>', '<For each={[] as string[]}>'),
]
target="src/task-ui/shared.tsx"
results=[]
try:
    for name,old,new in M:
        if old not in base:
            results.append((name,"MISSING")); continue
        open(target,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/shared.test.tsx"],capture_output=True,text=True,timeout=240)
        results.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
finally:
    open(target,"w").write(base)
for n,res in results: print(f"{res:9} {n}")
