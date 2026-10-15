import subprocess, os
P3=os.environ["P3"]
C=P3+"/packages/opencode/src/task/core/command.ts"; H=P3+"/packages/tui/src/routes/session/task-header.tsx"
files={f:open(f).read() for f in [C,H]}
OC=(["bun","test","test/task/core-command.test.ts","-t","header|VF8|SV26|stored run","--timeout","60000"], P3+"/packages/opencode")
TU=(["bun","test","test/routes/task-header.test.tsx"], P3+"/packages/tui")
M=[
 (C,OC,"subtree spec first",'`Implementing **${root.id} ${root.title}** from spec **${title}**`','`Implementing spec **${title}** for **${root.id} ${root.title}**`'),
 (C,OC,"no id fallback",'const title = plan.spec.title === "" ? id : plan.spec.title','const title = plan.spec.title'),
 (C,OC,"no left-out line",'text: left.length === 0 ? head :','text: true ? head :'),
 (C,OC,"metadata no task",'root ? [["task", { id: root.id, title: root.title }]] : []','[]'),
 (C,OC,"metadata title fallback",'[["spec", { id, title: plan.spec.title }]','[["spec", { id, title }]'),
 (C,OC,"no died part",'  ...Option.toArray(Option.map(diedLine(slice), (text) => ({ type: "text" as const, text }))),\n',''),
 (H,TU,"title not bold",'''        <b>
          <span style={{ fg: props.theme.text }}>{title()}</span>
        </b>''','''        <span style={{ fg: props.theme.text }}>{title()}</span>'''),
 (H,TU,"lead in text tone",'<text fg={props.theme.textMuted} wrapMode="word">\n        {props.header.task','<text fg={props.theme.text} wrapMode="word">\n        {props.header.task'),
 (H,TU,"no id fallback tui",'props.header.spec.title || props.header.spec.id','props.header.spec.title'),
 (H,TU,"no left-out tui",'<Show when={props.header.leftOut.length > 0}>','<Show when={false}>'),
 (H,TU,"split keeps header",'texts: texts.filter((item) => item !== found?.item).map((item) => item.text),','texts: texts.map((item) => item.text),'),
 (H,TU,"synthetic shown",'part.type === "text" && !part.synthetic &&','part.type === "text" &&'),
 (H,TU,"cut the title",'<span style={{ fg: props.theme.text }}>{title()}</span>','<span style={{ fg: props.theme.text }}>{title().length > 20 ? `${title().slice(0, 19)}…` : title()}</span>'),
]
res=[]
try:
    for f,(cmd,cwd),name,old,new in M:
        b=files[f]
        if old not in b: res.append((name,"MISSING")); continue
        open(f,"w").write(b.replace(old,new,1))
        r=subprocess.run(cmd,cwd=cwd,capture_output=True,text=True,timeout=900)
        res.append((name,"caught" if r.returncode!=0 else "SURVIVED"))
        open(f,"w").write(b)
finally:
    for f,b in files.items(): open(f,"w").write(b)
for n,r in res: print(f"{r:9} {n}")
