import subprocess, os
P=os.environ["P3"]
R=P+"/packages/opencode"
T=R+"/test/task/state-audit.test.ts"; UI=P+"/packages/tui/src/task-ui/ui.tsx"; W=P+"/packages/tui/src/task-ui/watch.tsx"; ST=P+"/packages/tui/src/task-ui/store.ts"
files={f:open(f).read() for f in [T,UI,W,ST]}
APPEND=object()
M=[
 (UI,"plant Effect.sleep in ui.tsx",APPEND,'\nexport const pause = Effect.sleep("1 second")\n'),
 (W,"plant view-state createSignal in watch.tsx",APPEND,'\nexport const [shown, setShown] = createSignal(false)\n'),
 (ST,"plant Schedule.spaced in store.ts",APPEND,'\nexport const every = Schedule.spaced("1 second")\n'),
 (UI,"plant Effect.repeat in ui.tsx",APPEND,'\nexport const again = effect.pipe(Effect.repeat({ times: 3 }))\n'),
 (T,"scanner misses createSignal",'const SIGNALS = ["createSignal", "createStore"]','const SIGNALS = ["createStore"]'),
 (T,"scanner misses Effect.sleep in the ui",'call.member === "sleep") add(node, "Effect.sleep")','call.member === "never") add(node, "Effect.sleep")'),
 (T,"scanner misses Schedule.spaced",'Schedule: ["spaced", "fixed"],','Schedule: ["fixed"],'),
 (T,"an extra allowlist entry",'const ALLOWLIST: ReadonlyArray<Entry> = [','const ALLOWLIST: ReadonlyArray<Entry> = [\n  { file: ui("watch.tsx"), identifier: "WatchBand", reason: "Interim." },'),
 (T,"an entry with no reason",'reason: "The proof-log flush: it copies process output to the log file inside one proof process\'s scope.",','reason: " ",'),
 (T,"DISPLAY entry dropped",'    file: ui("store.ts"),\n    identifier: "DISPLAY",','    file: ui("store.ts"),\n    identifier: "DISPLAY_GONE",'),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old is APPEND: m=b+new
        elif old not in b: res.append((name,"MISSING")); continue
        else: m=b.replace(old,new,1)
        open(f,"w").write(m)
        r=subprocess.run(["bun","test","test/task/state-audit.test.ts"],cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
print("done")
