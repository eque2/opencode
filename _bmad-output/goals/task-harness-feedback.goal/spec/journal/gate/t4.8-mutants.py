import subprocess, sys
SP=sys.argv[1]
U="src/task-ui/ui.tsx"; SH="src/task-ui/shared.tsx"; L="src/task-ui/designs/1-ledger.tsx"; D="src/task-ui/designs/2-dock.tsx"
H="src/task-ui/designs/6-hud.tsx"; T="src/task-ui/designs/7-ticker.tsx"; SC="src/task-ui/designs/screen.tsx"; I="src/task-ui/index.tsx"
files={f:open(f).read() for f in [U,SH,L,D,H,T,SC,I]}
M=[
 (U,"stopped at 0",'return stopped > 0 ? ` · ${stopped} stopped` : ""','return stopped >= 0 ? ` · ${stopped} stopped` : ""'),
 (U,"title ignored",'status.run.title || status.run.specId ||','status.run.specId ||'),
 (U,"no more count",'${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}','${""}'),
 (U,"reason always error",'tone: tagged(status.run, "stopped") ? ("error" as const) : ("muted" as const)','tone: "error" as const'),
 (U,"reason by state",'tone: tagged(status.run, "stopped") ? ("error" as const) : ("muted" as const)','tone: status.run.state === "done" ? ("muted" as const) : ("muted" as const)'),
 (U,"warning toast every time",'if (count === 0 || before?.run.warning) return','if (count === 0) return'),
 (U,"warning plural",'${count === 1 ? "failure" : "failures"}','failures'),
 (U,"warning toast info",'ctx.toast({ variant: "warning", title: MARK, message })','ctx.toast({ variant: "warning", title: NAME, message })'),
 (U,"no older line",'<For each={older(props.status) ? wrap(OLDER_LINE, props.width) : []}>','<For each={[] as string[]}>'),
 (U,"no warning line",'            {cut(warning().head, props.width)}\n','            {""}\n'),
 (U,"outside not wrapped",'<For each={wrap(outsideCollapsed(props.status) ?? "", props.width)}>','<For each={[cut(outsideCollapsed(props.status) ?? "", props.width)].filter(Boolean)}>'),
 (U,"stopped success tone",'<span style={{ fg: props.theme().error }}>{stoppedText(props.status)}</span>','<span style={{ fg: props.theme().success }}>{stoppedText(props.status)}</span>'),
 (SH,"command splits",'    .replace(COMMAND, `/task${JOIN}trust${JOIN}$1`)\n',''),
 (L,"ledger refused one line",'when={status().run.state === "refused"}','when={false}'),
 (L,"ledger spec line",'{cut(runTitle(status()), props.width)}','{cut(status().run.spec, props.width)}'),
 (SC,"screen refused body",'<Match when={status().run.state === "refused"}>','<Match when={false}>'),
 (SC,"screen spec title",'{`${runTitle(status())} · ${runText(status())}`}','{`${status().run.spec} · ${runText(status())}`}'),
 (SC,"room ignores header",'const room = () => props.height - 3 - headerLines()','const room = () => props.height - 3'),
 (T,"no blocker order",'.toSorted((a, b) => rank(a.unit) - rank(b.unit))',''),
 (T,"gained ignores blocked",'["dead", "blocked"].some(','["dead"].some('),
 (T,"gained ignores before",'tagged(task, tag) && !(was && tagged(was, tag))','tagged(task, tag)'),
 (T,"notice repeats",'if (!tagged(after.run, "ended") || tagged(before.run, "ended")) return','if (!tagged(after.run, "ended")) return'),
 (T,"notice for done line",'  if (!stopped && Option.isSome(line)) return Option.none<string>()\n',''),
 (T,"notice no reason",'${stopped && Option.isSome(line) ? `: ${line.value.text}` : ""}','${""}'),
 (D,"selected never drops",'selected: fixed + cost + chips + 3 + task <= props.width,','selected: true,'),
 (D,"cost never drops",'cost: fixed + cost + chips + 3 <= props.width,','cost: true,'),
 (D,"cost drops first",'selected: fixed + cost + chips + 3 + task <= props.width,','selected: fixed + chips + 3 + task <= props.width,'),
 (D,"no warning segment",'...(status.run.warning ? ["! spec"] : []),',''),
 (D,"no outside +N",'${waits.length > 1 ? ` +${waits.length - 1}` : ""}','${""}'),
 (D,"side at 150",'const SIDE_BY_SIDE = 110','const SIDE_BY_SIDE = 150'),
 (D,"peek half 50",'const PEEK_HALF = 72','const PEEK_HALF = 50'),
 (D,"full height",'const budget = () => Math.floor((props.height ?? 40) / 2)','const budget = () => props.height ?? 40'),
 (H,"hud bar not shrunk",'inner - 1 - trustedText(status()).length - stoppedText(status()).length','inner - 1 - trustedText(status()).length'),
 (I,"no warning toast",'  registerWarning({ view, toast: (toast) => api.ui.toast(toast) })\n',''),
]
results=[]
try:
    for f,name,old,new in M:
        base=files[f]
        if old not in base:
            results.append((name,"MISSING")); continue
        open(f,"w").write(base.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/designs.test.tsx","test/task-ui/task-ui.test.tsx","test/task-ui/shared.test.tsx","test/task-ui/plugin.test.tsx"],capture_output=True,text=True,timeout=500)
        out=r.stdout+r.stderr
        crashed = "error between tests" in out or "SyntaxError" in out
        results.append((name,("caught" if r.returncode!=0 else "SURVIVED")+(" (crash)" if crashed else "")))
        open(f,"w").write(base)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,res in results: print(f"{res:16} {n}")
