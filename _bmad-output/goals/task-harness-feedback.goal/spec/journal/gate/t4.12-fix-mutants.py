import subprocess, os
R=os.environ["P3"]+"/packages/tui"
U=R+"/src/task-ui/usage.ts"; P=R+"/src/component/prompt/index.tsx"
files={f:open(f).read() for f in [U,P]}
M=[
 (U,"own set to none",'const own = Option.map(input.own, (item) => [item.context, ...Option.toArray(item.cost)].join(" · "))','const own = Option.none<string>()'),
 (U,"own drops the cost",'[item.context, ...Option.toArray(item.cost)].join(" · ")','item.context'),
 (U,"room +100",'const room = input.width -','const room = 100 + input.width -'),
 (U,"session guard inverted",'if (!input.sessionID) return Option.none<string>()','if (input.sessionID) return Option.none<string>()'),
 (U,"no sidebar subtraction",'(input.width > 120 ? 42 : 0)','0'),
 (U,"padding 2",'(input.width > 120 ? 42 : 0) - 4 -','(input.width > 120 ? 42 : 0) - 2 -'),
 (P,"Match body blanked",'                          {text()}\n','                          {""}\n'),
 (P,"prompt passes no width",'      width: dimensions().width,','      width: 1000,'),
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
print("done")
