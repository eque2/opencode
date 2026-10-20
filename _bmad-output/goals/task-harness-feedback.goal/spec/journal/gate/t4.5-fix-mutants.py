import subprocess, sys
SP=sys.argv[1]
P="src/task-ui/peek.tsx"
base=open(SP+"/wip/peek.base.tsx").read()
M=[
 ("ignores startedAt",'current?.endedAt !== undefined && current.startedAt === undefined','current?.endedAt !== undefined'),
 ("blocked only",'current?.endedAt !== undefined && current.startedAt === undefined','current?.state === "blocked"'),
 ("meta before sentences",'return [...waitSentences(status, task), ...after]','return [...after, ...waitSentences(status, task)]'),
]
res=[]
try:
    for name,old,new in M:
        if old not in base: res.append((name,"MISSING")); continue
        open(P,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui"],capture_output=True,text=True,timeout=400)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
finally:
    open(P,"w").write(base)
for n,r in res: print(f"{r:9} {n}")
