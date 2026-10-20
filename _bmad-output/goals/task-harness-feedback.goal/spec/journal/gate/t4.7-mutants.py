import subprocess, sys
SP=sys.argv[1]
ST="src/task-ui/store.ts"; SH="src/task-ui/shared.tsx"; G="src/task-ui/designs/5-gantt.tsx"; H="src/task-ui/designs/6-hud.tsx"
files={f:open(f).read() for f in [ST,SH,G,H]}
M=[
 (ST,"span start now",'const start = status.run.startedAt ?? now','const start = now'),
 (ST,"span live to heartbeat",'(liveness === "live" ? now : (status.run.aliveAt ?? now))','(status.run.aliveAt ?? now)'),
 (ST,"span still to now",'(liveness === "live" ? now : (status.run.aliveAt ?? now))','now'),
 (ST,"span ignores endedAt",'const end = status.run.endedAt ?? (','const end = ('),
 (ST,"usage at zero",'return tokens > 0 ? Option.some','return tokens >= 0 ? Option.some'),
 (ST,"usage cost first",'sessions.reduce((sum, session) => sum + session.cost, 0)','(sessions[0]?.cost ?? 0)'),
 (ST,"tokens word",'`${Locale.number(tokens)} tokens`','`${Locale.number(tokens)} tok`'),
 (G,"tail 5%",'(run.end - run.start) * 0.03','(run.end - run.start) * 0.05'),
 (G,"tail no floor",'Math.max(1000, (run.end - run.start) * 0.03)','(run.end - run.start) * 0.03'),
 (G,"tail while live",'  if (status.run.endedAt === undefined) return run\n',''),
 (G,"zero-length ignored",'    if (span.to === span.from) states','    if (false) states'),
 (G,"open to range end",'at < (span.to ?? open)','at < (span.to ?? range.end)'),
 (G,"span end inclusive",'span.from <= at && at < (span.to ?? open)','span.from <= at && at <= (span.to ?? open)'),
 (G,"blank is waiting",'return spans.find((span) => span.from <= at && at < (span.to ?? open))?.state','return spans.find((span) => span.from <= at && at < (span.to ?? open))?.state ?? "waiting"'),
 (G,"one block",'(DISPLAY[run.state]?.block ?? "█")','"█"'),
 (G,"duration 6",'const DURATION = 7','const DURATION = 6'),
 (G,"state 20",'const STATE = 21','const STATE = 20'),
 (G,"lane min 5",'const LANE_MIN = 10','const LANE_MIN = 5'),
 (G,"gantt duration ended",'durationOf(row.task, status.run, props.view.liveness(), props.view.now())','durationOf(row.task, status.run, "ended", props.view.now())'),
 (G,"legend old",'█ ended, in its state\'s colour','█ trusted, or stopped in its colour'),
 (SH,"no +N",'${rest.length > 0 ? ` +${rest.length}` : ""}','${""}'),
 (SH,"last id",'const [first, ...rest] = outsideWaits(status)','const [first, ...rest] = outsideWaits(status).toReversed()'),
 (H,"no tail",'const tail = duration ? ` · ${duration}` : ""','const tail = ""'),
 (H,"cut whole line",'return `${lead}${cut(stateText(row), width - lead.length - tail.length)}${tail}`','return cut(`${lead}${stateText(row)}${tail}`, width)'),
 (H,"tokens never drop",'return full.length <= inner ? full : cut(`${time} · ${costText(usage.cost)}`, inner)','return cut(full, inner)'),
 (H,"cost drops",'cut(`${time} · ${costText(usage.cost)}`, inner)','cut(`${time} · ${tokensText(usage.tokens)}`, inner)'),
 (H,"no warning line",'                  {cut(warning().head, inner)}\n','                  {""}\n'),
 (H,"outside not wrapped",'<For each={wrap(outsideCollapsed(status()) ?? "", inner)}>','<For each={[cut(outsideCollapsed(status()) ?? "", inner)].filter(Boolean)}>'),
 (H,"hud span ended",'const range = runSpan(status, props.view.liveness(), props.view.now())','const range = runSpan(status, "ended", props.view.now())'),
]
results=[]
try:
    for f,name,old,new in M:
        base=files[f]
        if old not in base:
            results.append((name,"MISSING")); continue
        open(f,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/designs.test.tsx","test/task-ui/task-ui.test.tsx","test/task-ui/shared.test.tsx"],capture_output=True,text=True,timeout=400)
        out=r.stdout+r.stderr
        crashed = "error between tests" in out or "SyntaxError" in out
        results.append((name,("caught" if r.returncode!=0 else "SURVIVED")+(" (crash)" if crashed else "")))
        open(f,"w").write(base)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,res in results: print(f"{res:16} {n}")
