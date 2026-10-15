import subprocess, os
R=os.environ["P3"]+"/packages/opencode"
S=R+"/src/task/core/summary.ts"
base=open(S).read()
SUM=["bun","test","test/task/summary.test.ts","--timeout","60000"]
M=[
 ("stopped task reason raw",'      ...(first.reason ? [`  ${escape(oneLine(first.reason))}`] : []),','      ...(first.reason ? [`  ${oneLine(first.reason)}`] : []),'),
 ("blocked line reason raw",'${names} ${escape(oneLine(first.reason ?? label(first.state)))}','${names} ${oneLine(first.reason ?? label(first.state))}'),
 ("stop reason raw",'escape(reason?.split("\\n")[0] ?? "")','(reason?.split("\\n")[0] ?? "")'),
]
res=[]
try:
    for name,old,new in M:
        if old not in base: res.append((name,"MISSING")); continue
        open(S,"w").write(base.replace(old,new,1))
        r=subprocess.run(SUM,cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(S,"w").write(base)
finally:
    open(S,"w").write(base)
for n,r in res: print(f"{r:9} {n}")
print("done")
