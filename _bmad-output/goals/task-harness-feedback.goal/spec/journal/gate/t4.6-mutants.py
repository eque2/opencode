import subprocess, sys
SP=sys.argv[1]
B="src/task-ui/designs/3-board.tsx"; MX="src/task-ui/designs/4-matrix.tsx"; SC="src/task-ui/designs/screen.tsx"
files={f:open(f).read() for f in [B,MX,SC]}
M=[
 (B,"STOPPED unsorted",'column === "STOPPED" ? cards.toSorted((a, b) => stoppedGroup(a.task) - stoppedGroup(b.task)) : cards','cards'),
 (B,"STOPPED reversed",'stoppedGroup(a.task) - stoppedGroup(b.task)','stoppedGroup(b.task) - stoppedGroup(a.task)'),
 (B,"column by state",'Option.getOrUndefined(columnOf(row.task)) === column','(row.task.state === "waiting" ? "WAITING" : Option.getOrUndefined(columnOf(row.task))) === column'),
 (B,"blocked muted",'? [{ text: task.reason ?? label(task.state), tone: "warning" }]','? [{ text: task.reason ?? label(task.state), tone: "muted" }]'),
 (B,"no waiting branch",'      ? waitSentences(status, task)\n','      ? [{ text: label(task.state), tone: "muted" }]\n'),
 (B,"label tone text",': [{ text: label(task.state), tone: "muted" }]',': [{ text: label(task.state), tone: "text" }]'),
 (B,"meta never joins",'attempt && duration && `${attempt} · ${duration}`.length <= inner','false'),
 (B,"meta always joins",'attempt && duration && `${attempt} · ${duration}`.length <= inner','attempt && duration'),
 (B,"attempt 0 shown",'task.attempts > 0 ? `attempt','task.attempts >= 0 ? `attempt'),
 (B,"no duration",'const duration = durationOf(task, status.run, liveness, now)','const duration = ""'),
 (B,"duration ended",'durationOf(task, status.run, liveness, now)','durationOf(task, status.run, "ended", now)'),
 (B,"no proofs",'...(proofs.length > 0','...(false'),
 (B,"reason for blocked",'...(task.reason && !blocked','...(task.reason'),
 (B,"reason always bad",'tone: tagged(task, "dead") ? ("bad" as const) : ("muted" as const)','tone: "bad" as const'),
 (B,"clamp 4",'clamp(task.reason, inner, 3)','clamp(task.reason, inner, 4)'),
 (B,"clamp no ellipsis",'cut(lines.slice(max - 1).join(" "), width)','lines[max - 1]'),
 (B,"card rows 2",'sum + 3 + cardLines','sum + 2 + cardLines'),
 (B,"id line not toned",'<text fg={stateColor(props.theme(), props.row.task.state)} wrapMode="none">\n        <b>','<text fg={props.theme().text} wrapMode="none">\n        <b>'),
 (MX,"gap 1",'const GAP = 2','const GAP = 1'),
 (MX,"time 6",'const TIME = 7','const TIME = 6'),
 (MX,"time left",'duration().padStart(TIME)','duration().padEnd(TIME)'),
 (MX,"label never cuts",'Math.max(0, Math.min(LABEL, props.width - columns().length * CELL - GAP - TIME))','LABEL'),
 (MX,"matrix duration ended",'props.view.liveness(), props.view.now()) : ""','"ended", props.view.now()) : ""'),
 (MX,"legend no blocked",' ⊖ blocked\n','\n'),
 (MX,"matrix rows open +1",'(open > 0 ? open + 2 : 0)','(open > 0 ? open + 3 : 0)'),
 (SC,"beside at 150",'const BESIDE_BOARD = 149','const BESIDE_BOARD = 150'),
 (SC,"split at 100",'const SIDE_BY_SIDE = 110','const SIDE_BY_SIDE = 100'),
 (SC,"split at 120",'const SIDE_BY_SIDE = 110','const SIDE_BY_SIDE = 120'),
 (SC,"peek half 60",'const PEEK_HALF = 72','const PEEK_HALF = 60'),
 (SC,"split region first",'<box flexDirection="row" gap={1} flexShrink={0}>\n                    {peek()}\n                    {shared()}','<box flexDirection="row" gap={1} flexShrink={0}>\n                    {shared()}\n                    {peek()}'),
 (SC,"board stack region first",'<Match when={SCREENS[props.view.design()] === "right"}>\n                  {peek()}\n                  {shared()}','<Match when={SCREENS[props.view.design()] === "right"}>\n                  {shared()}\n                  {peek()}'),
 (SC,"matrix peek first",'<Match when={true}>\n                  {shared()}\n                  {peek()}','<Match when={true}>\n                  {peek()}\n                  {shared()}'),
 (SC,"right pane no region",'<box flexDirection="column" width={PEEK_RIGHT} flexShrink={0}>\n                    {peek()}\n                    {shared()}','<box flexDirection="column" width={PEEK_RIGHT} flexShrink={0}>\n                    {peek()}'),
]
results=[]
try:
    for f,name,old,new in M:
        base=files[f]
        if old not in base:
            results.append((name,"MISSING")); continue
        open(f,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/designs.test.tsx","test/task-ui/shared.test.tsx","test/task-ui/task-ui.test.tsx"],capture_output=True,text=True,timeout=400)
        out=r.stdout+r.stderr
        crashed = "error between tests" in out or "SyntaxError" in out
        results.append((name,("caught" if r.returncode!=0 else "SURVIVED")+(" (crash)" if crashed else "")))
        open(f,"w").write(base)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,res in results: print(f"{res:16} {n}")
