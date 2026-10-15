import subprocess, sys
SP=sys.argv[1]
files={"src/task-ui/peek.tsx":open(SP+"/wip/peek.base.tsx").read(),"src/task-ui/shared.tsx":open(SP+"/wip/shared45.base.tsx").read()}
P="src/task-ui/peek.tsx"; S="src/task-ui/shared.tsx"
M=[
 (P,"no blocked branch",'  if (tagged(task, "blocked")) return [{ text: task.reason ?? label(task.state), tone: "warning" }, ...after]\n',''),
 (P,"blocked muted",'{ text: task.reason ?? label(task.state), tone: "warning" }','{ text: task.reason ?? label(task.state), tone: "muted" }'),
 (P,"no after for blocked",'tone: "warning" }, ...after]','tone: "warning" }]'),
 (P,"no waiting branch",'  if (tagged(task, "waiting") && task.waitingOn.length > 0) return [...waitSentences(status, task), ...after]\n',''),
 (P,"label last",'text: [label(task.state), ...meta].join(" · ")','text: [...meta, label(task.state)].join(" · ")'),
 (P,"attempt 0 shown",'task.attempts > 0 ? `attempt','task.attempts >= 0 ? `attempt'),
 (P,"no duration",', durationOf(task, status.run, liveness, now)]',']'),
 (P,"reason always bad",'tagged(task, "dead") ? ("bad" as const) : ("muted" as const)','("bad" as const)'),
 (P,"reason always muted",'tagged(task, "dead") ? ("bad" as const) : ("muted" as const)','("muted" as const)'),
 (P,"no reason",'...(task.reason ? [{ text: task.reason,','...(false ? [{ text: task.reason,'),
 (P,"wrap full width",'wrap(piece.text, inner() - 9)','wrap(piece.text, inner())'),
 (P,"indent 8",'" ".repeat(9)','" ".repeat(8)'),
 (P,"no shrink",'Math.max(1, props.lines - Math.max(0, heading().length - 1))','props.lines'),
 (P,"shrink to 0",'Math.max(1, props.lines - Math.max(0, heading().length - 1))','Math.max(0, props.lines - Math.max(0, heading().length - 1))'),
 (P,"always yet",'? ": the task did not start" : " yet"','? " yet" : " yet"'),
 (P,"ignores endedAt",'current?.endedAt !== undefined && current.startedAt === undefined','current?.startedAt === undefined'),
 (P,"verifier yet",'text={`no verifier session${missing()}`}','text="no verifier session yet"'),
 (P,"liveness ended",'props.view.liveness(), props.view.now()','"ended", props.view.now()'),
 (S,"plan includes outside",'(id) => !outside.includes(id) && !external.includes(id)','(id) => !external.includes(id)'),
 (S,"outside trusted too",'      .filter((id) => status.outside?.[id]?.state === "untrusted")\n',''),
 (S,"plan muted->text",'{ text: `waiting on ${plan.join(", ")}`, tone: "muted" as const }','{ text: `waiting on ${plan.join(", ")}`, tone: "text" as const }'),
 (S,"outside muted",'.map((id) => ({ text: outsideLine(id), tone: "warning" as const }))','.map((id) => ({ text: outsideLine(id), tone: "muted" as const }))'),
 (S,"external warning",'`waiting on ${id} (not in this run)`, tone: "muted" as const','`waiting on ${id} (not in this run)`, tone: "warning" as const'),
 (S,"external words",'(not in this run)','(external)'),
 (S,"no word split",'    .flatMap((word) =>\n      Array.from({ length: Math.ceil(word.length / room) }, (_, i) => word.slice(i * room, (i + 1) * room)),\n    )\n',''),
 (S,"wrap strict",'`${last} ${word}`.length <= room\n','`${last} ${word}`.length < room\n'),
]
results=[]
try:
    for f,name,old,new in M:
        base=files[f]
        if old not in base:
            results.append((name,"MISSING")); continue
        open(f,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx"],capture_output=True,text=True,timeout=300)
        results.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(base)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,res in results: print(f"{res:9} {n}")
