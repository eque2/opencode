import subprocess, os
R=os.environ["P3"]+"/packages/opencode"
S=R+"/src/task/core/summary.ts"; W=R+"/src/task/core/workers.ts"; E=R+"/src/task/engine-xstate/index.ts"
files={f:open(f).read() for f in [S,W,E]}
SUM=(["bun","test","test/task/summary.test.ts","--timeout","60000"],R)
M=[
 (W,SUM,"warned always false",'warned: TaskEngineXState.warned(snapshot),','warned: false,'),
 (W,SUM,"warned always true",'warned: TaskEngineXState.warned(snapshot),','warned: true,'),
 (W,SUM,"no children read",'const spent = yield* run.env.sessions.children(run.root)','const spent = [] as never[]'),
 (W,SUM,"children of another session",'run.env.sessions.children(run.root)','run.env.sessions.children(run.id)'),
 (E,SUM,"one failure not counted",'/^spec\\.checked: \\d+ failures?$/','/^spec\\.checked: \\d+ failures$/'),
 (E,SUM,"latest check only",'snapshot.context.log.some(','snapshot.context.log.slice(-1).some('),
 (S,SUM,"spec title raw",'const title = `**${escape(status.run.title)}**`','const title = `**${status.run.title}**`'),
 (S,SUM,"task title raw",'escape(status.run.task.title)','status.run.task.title'),
 (S,SUM,"failed scenario title raw",'` · ${escape(first.title)}`','` · ${first.title}`'),
 (S,SUM,"parked scenario title raw",'**${id}** ${escape(scenario.title)}','**${id}** ${scenario.title}'),
]
res=[]
try:
    for f,(cmd,cwd),name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(cmd,cwd=cwd,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
print("done")
