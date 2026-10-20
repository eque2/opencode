import subprocess, sys
SP=sys.argv[1]
S="src/task-ui/shared.tsx"; SC="src/task-ui/designs/screen.tsx"; B="src/task-ui/designs/3-board.tsx"; MX="src/task-ui/designs/4-matrix.tsx"; G="src/task-ui/designs/5-gantt.tsx"
files={f:open(f).read() for f in [S,SC,B,MX,G]}
KEY='`${row.task.state}\\n${row.task.reason ?? ""}`'
M=[
 (S,"key by state (both places)",KEY,'row.task.state',True),
 (S,"key by reason (both places)",KEY,'(row.task.reason ?? "")',True),
 (S,"short at 31",'const short = width < 30','const short = width < 31',False),
 (S,"heading by state",'tagged(scenario, "ended") && !tagged(scenario, "stopped")','scenario.state === "passed" || scenario.state === "trusted"',False),
 (S,"entry not fit",'  return fit(\n    [lead, ...labelPieces, { text: " · ", tone: "muted" }, { text: cut(entry.title, titleRoom), tone: "text" }],\n    width,\n  )','  return [lead, ...labelPieces, { text: " · ", tone: "muted" }, { text: cut(entry.title, titleRoom), tone: "text" }]',False),
 (S,"outside rows 1 each",'outsideWaits(status).reduce((sum, id) => sum + wrap(outsideLine(id), width).length, 0)','outsideWaits(status).length',False),
 (SC,"no clip",' overflow="hidden">\n                <Switch','>\n                <Switch',False),
 (SC,"never shrink",'return 1 + tall + region() > room() ? 1 : full','return full',False),
 (SC,"always shrink",'return 1 + tall + region() > room() ? 1 : full','return 1',False),
 (SC,"peek rows small",'const peekRows = (lines: number) => 5 + 3 * lines','const peekRows = (lines: number) => lines',False),
 (B,"board card rows less",'  4 +\n  (attemptText(row) ? 1 : 0)','  3 +\n  (attemptText(row) ? 1 : 0)',False),
 (B,"board no reason rows",'(row.task.reason ? wrap(cut(row.task.reason, (width - 4) * 3), width - 4).length : 0)','0',False),
 (MX,"matrix no open rows",'(open > 0 ? open + 2 : 0)','0',False),
 (MX,"matrix chips one row",'return 1 + view.rows().length + 2 + chips + 2','return 1 + view.rows().length + 2 + 1 + 2',False),
 (G,"gantt no legend",'export const ganttRows = (view: View) => 1 + view.rows().length + 2','export const ganttRows = (view: View) => 1 + view.rows().length',False),
]
results=[]
try:
    for f,name,old,new,every in M:
        base=files[f]
        if old not in base:
            results.append((name,"MISSING")); continue
        open(f,"w").write(base.replace(old,new) if every else base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/shared.test.tsx"],capture_output=True,text=True,timeout=300)
        out=r.stdout+r.stderr
        crashed = "error between tests" in out or "SyntaxError" in out or "TypeError" in out
        results.append((name,("caught" if r.returncode!=0 else "SURVIVED")+(" (crash)" if crashed else "")))
        open(f,"w").write(base)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,res in results: print(f"{res:16} {n}")
