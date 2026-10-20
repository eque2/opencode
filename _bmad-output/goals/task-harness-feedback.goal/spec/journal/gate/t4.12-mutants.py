import subprocess, os
R=os.environ["P3"]+"/packages/tui"
U=R+"/src/task-ui/usage.ts"; C=R+"/src/feature-plugins/sidebar/context.tsx"; S=R+"/src/task-ui/designs/screen.tsx"; T=R+"/src/task-ui/designs/7-ticker.tsx"; A=R+"/src/plugin/adapters.tsx"
files={f:open(f).read() for f in [U,C,S,T,A]}
M=[
 (U,"any session",'sessions.filter((item) => item.parentID === root)','sessions.filter((item) => item.id !== root)'),
 (U,"every root",'children.some((child) => harnessOf(child).length > 0)','children.length >= 0'),
 (U,"cache counted",'child.tokens.input + child.tokens.output + child.tokens.reasoning','child.tokens.input + child.tokens.output + child.tokens.reasoning + 1'),
 (U,"no word drop",'        `run ${Locale.number(usage.tokens)} · ${cost}`,\n',''),
 (U,"own kept narrow",'        `run ${Locale.number(usage.tokens)} tokens · ${cost}`,\n        `run ${Locale.number(usage.tokens)} · ${cost}`,','        `run ${Locale.number(usage.tokens)} · ${cost}`,'),
 (C,"own lines always",'const own = createMemo(() => !root() || state().tokens > 0)','const own = createMemo(() => true)'),
 (C,"no run lines",'<For each={Option.match(run(), { onNone: () => [], onSome: (usage) => [usage] })}>','<For each={[] as Array<{ tokens: number; cost: number }>}>'),
 (S,"tokens never drop",'[`${tokensText(spent.tokens)} · ${costText(spent.cost)}`, costText(spent.cost)].find(','[`${tokensText(spent.tokens)} · ${costText(spent.cost)}`].find('),
 (T,"ticker no cost",'onSome: (spent) => ` · ${costText(spent.cost)}`','onSome: () => ""'),
 (A,"adapter all sessions",'return sync.data.session.filter((item) => item.parentID === sessionID)','return sync.data.session'),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/usage.test.tsx"],cwd=R,capture_output=True,text=True,timeout=600)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
