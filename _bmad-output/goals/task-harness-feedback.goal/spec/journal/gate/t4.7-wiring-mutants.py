import subprocess, sys
G="src/task-ui/designs/5-gantt.tsx"; H="src/task-ui/designs/6-hud.tsx"
files={f:open(f).read() for f in [G,H]}
M=[
 (G,"range still",'ganttRange(status, props.view.liveness(), props.view.now())','ganttRange(status, "still", props.view.now())'),
 (G,"open to tail",'runSpan(status, props.view.liveness(), props.view.now()).end','ganttRange(status, props.view.liveness(), props.view.now()).end'),
 (H,"hud line ended",'durationOf(row().task, status().run, props.view.liveness(), props.view.now())','durationOf(row().task, status().run, "ended", props.view.now())'),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/designs.test.tsx"],capture_output=True,text=True,timeout=300)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
