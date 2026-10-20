import subprocess, sys
U="src/task-ui/ui.tsx"; W="src/task-ui/watch.tsx"; I="src/task-ui/index.tsx"
files={f:open(f).read() for f in [U,W,I]}
M=[
 (U,"frames order",'const FRAMES = ["·", "⬩", "⬪", "⬥", "◆", "⬥", "⬪", "⬩"]','const FRAMES = ["◆", "⬥", "⬪", "⬩", "·", "⬩", "⬪", "⬥"]'),
 (U,"interval 80",'interval={120}','interval={80}'),
 (U,"spinner muted",'<spinner frames={FRAMES} interval={120} color={props.theme().accent} />','<spinner frames={FRAMES} interval={120} color={props.theme().textMuted} />'),
 (U,"moving ignores liveness",'props.view.liveness() === "live" && (props.motion?.() ?? false)','(props.motion?.() ?? false)'),
 (U,"moving ignores motion",'props.view.liveness() === "live" && (props.motion?.() ?? false)','props.view.liveness() === "live"'),
 (U,"moving when not ended",'props.view.liveness() === "live" &&','props.view.liveness() !== "ended" &&'),
 (U,"static bold",'''          <text fg={props.theme().accent} wrapMode="none">
            ◆
          </text>''','''          <text fg={props.theme().accent} wrapMode="none">
            <b>◆</b>
          </text>'''),
 (U,"name not bold",'<b>{` ${NAME}`}</b>','{` ${NAME}`}'),
 (U,"switch kept",'''    { key: `${leader} o`, label: view.expanded() ? "collapse" : "expand" },
    live ?''','''    { key: `${leader} o`, label: view.expanded() ? "collapse" : "expand" },
    { key: "/task-design", label: "switch" },
    live ?'''),
 (U,"no warning part",'...(status.run.warning ? [{ key: "! spec", label: "", color: props.theme().warning }] : []),',''),
 (U,"warning part text tone",'[{ key: "! spec", label: "", color: props.theme().warning }]','[{ key: "! spec", label: "" }]'),
 (U,"outside no label",'label: "outside wait",','label: "",'),
 (U,"no stopped part",'...(stopped ? [{ key: stopped, label: "", color: props.theme().error }] : []),',''),
 (U,"stopped text tone",'[{ key: stopped, label: "", color: props.theme().error }]','[{ key: stopped, label: "" }]'),
 (U,"ticker order",'? [...alerts, ...trusted, ...ticker, ...keys]','? [...alerts, ...ticker, ...trusted, ...keys]'),
 (U,"screen order",'? [...alerts, ...keys, ...trusted]','? [...keys, ...alerts, ...trusted]'),
 (U,"collapsed alerts last",': [...alerts, ...keys]',': [...keys, ...alerts]'),
 (U,"bar skips",'return fit.full || fit.used + size > room','return fit.used + size > room'),
 (W,"band ignores live",'moving={props.live && (props.motion ?? false)}','moving={props.motion ?? false}'),
 (W,"band ignores motion",'moving={props.live && (props.motion ?? false)}','moving={props.live}'),
 (I,"plugin no motion",'motion: () => api.kv.get("animations_enabled", true),','motion: () => false,'),
 (I,"plugin ignores kv",'motion: () => api.kv.get("animations_enabled", true),','motion: () => true,'),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx","test/task-ui/plugin.test.tsx"],capture_output=True,text=True,timeout=500)
        out=r.stdout+r.stderr
        crashed="error between tests" in out or "SyntaxError" in out
        res.append((name,("caught" if r.returncode!=0 else "SURVIVED")+(" (crash)" if crashed else "")))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:16} {n}")
