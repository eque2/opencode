import subprocess, os
R=os.environ["P3"]+"/packages/tui"
W=R+"/src/task-ui/watch.tsx"
base=open(W).read()
M=[
 ("esc layer ignores liveness",'    if (!view.watching() || !view.live() || !ctx.owns() || !onRoot()) return','    if (!view.watching() || !ctx.owns() || !onRoot()) return'),
 ("toggle ignores liveness",'    if (!view.live() || !ctx.owns()) return','    if (!view.status() || !ctx.owns()) return'),
]
res=[]
try:
    for name,old,new in M:
        if old not in base: res.append((name,"MISSING")); continue
        open(W,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx","--timeout","60000"],cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(W,"w").write(base)
finally:
    open(W,"w").write(base)
for n,r in res: print(f"{r:9} {n}")
