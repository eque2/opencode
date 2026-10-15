import subprocess, os
R=os.environ["P3"]+"/packages/tui"
D=R+"/src/task-ui/"
SITES=[("T watch band always live",D+"watch.tsx",'live={view.live()}','live={true}')]
for name,f in [("c dock","designs/2-dock.tsx"),("d hud","designs/6-hud.tsx"),("e screen","designs/screen.tsx"),("f ticker","designs/7-ticker.tsx"),("g bar","ui.tsx"),("ledger","designs/1-ledger.tsx")]:
    SITES.append((name+" ignores liveness",D+f,'moving={moving(props)}','moving={props.motion?.() ?? false}'))
files={f:open(f).read() for _,f,_,_ in SITES}
res=[]
try:
    for name,f,old,new in SITES:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx","-t","bar: UI14","--timeout","60000"],cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
print("done")
