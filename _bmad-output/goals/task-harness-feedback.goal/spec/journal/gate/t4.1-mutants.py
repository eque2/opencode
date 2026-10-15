import subprocess, sys, shutil
SP=sys.argv[1]
base=open(SP+"/wip/machine.base.ts").read()
M=[
 ("nextRunning backward", '"select.nextRunning": { actions: assign({ chosen: ({ context }) => running(context, 1) }) }', '"select.nextRunning": { actions: assign({ chosen: ({ context }) => running(context, -1) }) }'),
 ("previousRunning forward", '"select.previousRunning": { actions: assign({ chosen: ({ context }) => running(context, -1) }) }', '"select.previousRunning": { actions: assign({ chosen: ({ context }) => running(context, 1) }) }'),
 ("next backward", '"select.next": { actions: assign({ chosen: ({ context }) => stepped(context, 1) }) }', '"select.next": { actions: assign({ chosen: ({ context }) => stepped(context, -1) }) }'),
 ("previous forward", '"select.previous": { actions: assign({ chosen: ({ context }) => stepped(context, -1) }) }', '"select.previous": { actions: assign({ chosen: ({ context }) => stepped(context, 1) }) }'),
 ("expand.toggle stays", '"expand.toggle": "collapsed"', '"expand.toggle": "expanded"'),
 ("expand.set open guard", 'on: { "expand.toggle": "expanded", "expand.set": { guard: ({ event }) => event.open, target: "expanded" } }', 'on: { "expand.toggle": "expanded", "expand.set": { guard: ({ event }) => !event.open, target: "expanded" } }'),
 ("expand.set close guard", '"expand.set": { guard: ({ event }) => !event.open, target: "collapsed" }', '"expand.set": { guard: ({ event }) => event.open, target: "collapsed" }'),
 ("watch.toggle stays", 'on: { on: { "watch.toggle": "off"', 'on: { on: { "watch.toggle": "on"'),
 ("watch.set on guard", '"watch.set": { guard: ({ event }) => event.on, target: "on" }', '"watch.set": { guard: ({ event }) => !event.on, target: "on" }'),
 ("watch.set off guard", '"watch.set": { guard: ({ event }) => !event.on, target: "off" }', '"watch.set": { guard: ({ event }) => event.on, target: "off" }'),
 ("watch off keeps target", 'entry: assign({ target: "" }),', ''),
 ("mtime kept", 'mtime: got.mtime,', 'mtime: got.text === context.text ? context.mtime : got.mtime,'),
 ("logs kept", 'logs: got.logs,', 'logs: got.text === context.text ? context.logs : got.logs,'),
 ("now kept", 'now: got.now,', 'now: got.text === context.text ? context.now : got.now,'),
 ("fallback first row", 'Option.orElse(() => Option.fromNullishOr(focus(list))),', 'Option.orElse(() => Option.fromNullishOr(list[0]?.id)),'),
 ("cycle no wrap", '(context.design % DESIGNS.length) + 1', 'context.design + 1'),
 ("design.set unguarded", '"design.set": { guard: ({ event }) => isDesign(event.id), actions', '"design.set": { actions'),
 ("root ignores parent", 'root: ({ event }) => event.parent ?? event.session', 'root: ({ event }) => event.session'),
 ("target keep ignored", '"watch.target": { guard: ({ event }) => !event.keep, actions', '"watch.target": { actions'),
 ("owns not kept", 'owns: ({ event }) => event.owns,', 'owns: () => false,'),
 ("updated not kept", 'updated: ({ event }) => event.updated', 'updated: () => 0'),
 ("live strict", 'context.now - alive <= LIVE_MS', 'context.now - alive < LIVE_MS'),
 ("ended tag ignored", 'if (status.run.tags?.includes("ended")) return "ended"', ''),
 ("armed never times out", 'after: { stopWindow: "disarmed" },', ''),
 ("armed ignores liveness", 'always: { guard: ({ context }) => livenessOf(context) !== "live", target: "disarmed" },', ''),
 ("armed ignores route", ', "route.changed": "disarmed"', ''),
 ("disarmed ignores liveness", 'guard: ({ context }) => livenessOf(context) === "live",\n              target: "armed"', 'target: "armed"'),
 ("stop emits warn", 'actions: emit({ type: "stop.run" })', 'actions: emit({ type: "stop.warn" })'),
 ("parse failure clears", ': parse(got.text).pipe(Option.orElse(() => context.status)),', ': parse(got.text),'),
 ("gone file keeps", '!got.exists\n                      ? Option.none<Status>()', '!got.exists\n                      ? context.status'),
 ("feed 2 s", 'feed: 1_000,', 'feed: 2_000,'),
 ("sessions 3 s", 'sessions: 2_000,', 'sessions: 3_000,'),
 ("activity 1 s", 'activity: 1_500,', 'activity: 1_000,'),
 ("tail 1 s", 'tail: 500,', 'tail: 1_000,'),
 ("stop window 3 s", 'stopWindow: 5_000', 'stopWindow: 3_000'),
 ("bad design starts", 'design: isDesign(input.design) ? input.design : 1,', 'design: input.design,'),
]
target="src/task-ui/machine.ts"
results=[]
for name,old,new in M:
    if old not in base:
        results.append((name,"MISSING")); continue
    open(target,"w").write(base.replace(old,new,1))
    r=subprocess.run(["bun","test","test/task-ui/machine.test.ts"],capture_output=True,text=True,timeout=240)
    out=r.stdout+r.stderr
    caught = r.returncode!=0
    results.append((name,"caught" if caught else "SURVIVED"))
open(target,"w").write(base)
for n,res in results: print(f"{res:9} {n}")
