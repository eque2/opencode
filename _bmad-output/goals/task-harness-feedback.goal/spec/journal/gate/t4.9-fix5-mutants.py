import subprocess, os
R=os.environ["P3"]+"/packages/tui"
W=R+"/src/task-ui/watch.tsx"
base=open(W).read()
OLD='<Brand theme={props.theme} moving={props.live && (props.motion ?? false)} />'
M=[
 ("k11 band mark only while live",'{props.live ? <Brand theme={props.theme} moving={props.motion ?? false} /> : null}'),
 ("band mark only while moving",'{props.live && (props.motion ?? false) ? <Brand theme={props.theme} moving={true} /> : null}'),
]
res=[]
try:
    for name,new in M:
        if OLD not in base: res.append((name,"MISSING")); continue
        open(W,"w").write(base.replace(OLD,new,1))
        r=subprocess.run(["bun","test","test/task-ui/task-ui.test.tsx","-t","bar: UI14","--timeout","60000"],cwd=R,capture_output=True,text=True,timeout=1200)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(W,"w").write(base)
finally:
    open(W,"w").write(base)
for n,r in res: print(f"{r:9} {n}")
print("done")
