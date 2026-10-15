import subprocess, os
R=os.environ["P3"]+"/packages/opencode"
S=R+"/src/task/core/summary.ts"; W=R+"/src/task/core/workers.ts"; U=R+"/src/task/core/supervise/run.ts"; P=R+"/src/session/prompt.ts"; C=R+"/src/task/core/command.ts"
files={f:open(f).read() for f in [S,W,U,P,C]}
SUM=(["bun","test","test/task/summary.test.ts","--timeout","60000"],R)
SAY=(["bun","test","test/session/prompt.test.ts","-t","summary:","--timeout","60000"],R)
M=[
 (S,SUM,"escape misses pipe",'text.replace(/[\\\\*_`|<>[\\]]/g, "\\\\$&")','text.replace(/[\\\\*_`<>[\\]]/g, "\\\\$&")'),
 (S,SUM,"usage counts cache",'session.tokens.input + session.tokens.output + session.tokens.reasoning','session.tokens.input + session.tokens.output + session.tokens.reasoning + 1'),
 (S,SUM,"stop before dead",'const outcome = tasks.some(([, task]) => tagged(task, "dead"))','const outcome = Option.isNone(input.stop) && tasks.some(([, task]) => tagged(task, "dead"))'),
 (S,SUM,"done without not run",'`done${notRun}`','"done"'),
 (S,SUM,"scenario part always",'...(scenarioUnits.length === 0','...(false'),
 (S,SUM,"usage shown at zero",'input.usage.tokens > 0 ?','input.usage.tokens >= 0 ?'),
 (S,SUM,"reason keeps newlines",'      ...(first.reason ? [`  ${escape(oneLine(first.reason))}`] : []),\n    ]\n  })','      ...(first.reason ? [`  ${escape(first.reason)}`] : []),\n    ]\n  })'),
 (S,SUM,"no warning line",'...(input.warned ?','...(false ?'),
 (S,SUM,"no dash",'() => "—")','() => "0s")'),
 (U,SUM,"summary before release",'onDone: [{ guard: "outcome", target: "summarizing" }, { target: "closed" }],','onDone: "closed",'),
 (W,SUM,"no dropped log",'    Effect.onInterrupt(() => Effect.logWarning("task harness: the closing summary was dropped", { runID: run.id })),\n',''),
 (W,SUM,"failure not logged",'Effect.logError("task harness: the closing summary could not be written", { runID: run.id, cause }),','Effect.void,'),
 (P,SAY,"say does not wait",'.pipe(Effect.repeat({ while: () => !wrote }))','.pipe(Effect.as(undefined))'),
 (P,SAY,"parent is last user",'const parent = header ?? msgs.findLast((msg) => msg.info.role === "user")','const parent = msgs.findLast((msg) => msg.info.role === "user")'),
 (P,SAY,"no finish",'          finish: "stop",\n',''),
 (C,SUM,"job message back",'          Effect.as(""),','          Effect.as("the task run ended ${state}"),'),
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
