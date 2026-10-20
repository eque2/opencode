import subprocess
U="src/task-ui/ui.tsx"; L="src/task-ui/designs/1-ledger.tsx"; D="src/task-ui/designs/2-dock.tsx"; H="src/task-ui/designs/6-hud.tsx"; T="src/task-ui/designs/7-ticker.tsx"; S="src/task-ui/designs/screen.tsx"
files={f:open(f).read() for f in [U,L,D,H,T,S]}
M=[
 (U,"name bold only moving",'<b>{` ${NAME}`}</b>','{props.moving ? <b>{` ${NAME}`}</b> : ` ${NAME}`}'),
 (L,"ledger no motion",' motion={ctx.motion} />','  />'),
 (D,"dock no motion",'              motion={ctx.motion}\n',''),
 (H,"hud no motion",' motion={ctx.motion} />','  />'),
 (T,"ticker no motion",'              motion={ctx.motion}\n',''),
 (S,"screen no motion",'            motion={ctx.motion}\n',''),
]
res=[]
try:
    for f,name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx"],capture_output=True,text=True,timeout=400)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
