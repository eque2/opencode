import subprocess, os
R=os.environ["P3"]+"/packages/tui"
D=R+"/src/task-ui/"
OLD='<Brand theme={props.theme} moving={moving(props)} />'
NEW='{moving(props) ? <Brand theme={props.theme} moving={true} /> : null}'
SITES=[(n,D+f) for n,f in [("k1 dock","designs/2-dock.tsx"),("k2 hud","designs/6-hud.tsx"),("k3 screen","designs/screen.tsx"),("k4 ticker","designs/7-ticker.tsx"),("k5 bar","ui.tsx"),("k6 ledger","designs/1-ledger.tsx")]]
files={f:open(f).read() for _,f in SITES}
res=[]
try:
    for name,f in SITES:
        b=files[f]
        if OLD not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(OLD,NEW,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx","-t","bar: UI14","--timeout","60000"],cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name+" hides the still mark","caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
print("done")
