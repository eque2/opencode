import subprocess
D="src/task-ui/designs/2-dock.tsx"; T="src/task-ui/designs/7-ticker.tsx"; SC="src/task-ui/designs/screen.tsx"; U="src/task-ui/ui.tsx"
files={f:open(f).read() for f in [D,T,SC,U]}
M=[
 (D,"A1 dock stopped success",'<span style={{ fg: props.theme().error }}>{stoppedText(status())}</span>','<span style={{ fg: props.theme().success }}>{stoppedText(status())}</span>'),
 (D,"A2 dock alerts text",'''                  <text fg={props.theme().warning} wrapMode="none" flexShrink={0}>
                    {alert}''','''                  <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
                    {alert}'''),
 (D,"A3 side 120",'const SIDE_BY_SIDE = 110','const SIDE_BY_SIDE = 120'),
 (D,"A4 side 101",'const SIDE_BY_SIDE = 110','const SIDE_BY_SIDE = 101'),
 (T,"A5 notice by state",'if (!tagged(after.run, "ended") || tagged(before.run, "ended"))','if (before.run.state === after.run.state || !["done", "budget_exhausted", "cancelled", "failed", "needs_human", "refused"].includes(after.run.state))'),
 (T,"A6 no notify",'Option.map(endNotice(before, after), (message) => void ctx.api.attention.notify({ title: NAME, message }))','void endNotice'),
 (SC,"header not cut",'{cut(`${runTitle(status())} · ${runText(status())}`, titleRoom())}','{`${runTitle(status())} · ${runText(status())}`}'),
 (U,"refused by state",'tagged(status.run, "stopped") && Object.keys(status.tasks).length === 0','status.run.state === "refused" || Object.keys(status.tasks).length === 0'),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/designs.test.tsx"],capture_output=True,text=True,timeout=400)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
