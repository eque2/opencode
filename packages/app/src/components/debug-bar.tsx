import { useIsRouting, useLocation } from "@solidjs/router"
import { batch, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Chunk, Data, Effect, MutableHashMap, Option, Result } from "effect"
import { createFiberSlot } from "@/utils/fiber-slot"

type Mem = Performance & {
  memory?: {
    usedJSHeapSize: number
    jsHeapSizeLimit: number
  }
}

type Evt = PerformanceEntry & {
  interactionId?: number
  processingStart?: number
}

type Shift = PerformanceEntry & {
  hadRecentInput: boolean
  value: number
}

/** True for a layout-shift entry. The DOM typings have no LayoutShift type, so the fields are checked. */
const isShift = (entry: PerformanceEntry): entry is Shift =>
  "hadRecentInput" in entry &&
  typeof entry.hadRecentInput === "boolean" &&
  "value" in entry &&
  typeof entry.value === "number"

type Obs = PerformanceObserverInit & {
  durationThreshold?: number
}

/** One frame or long task: its start time and its duration, in milliseconds. */
type Sample = { at: number; dur: number }

/** A measured value. None means that the bar has no sample yet. */
type Metric = Option.Option<number>

const span = 5000

/** A force-focus request that the desktop shell rejected. `cause` is the rejection. */
class ForceFocusError extends Data.TaggedError("App.ForceFocusError")<{ readonly cause: unknown }> {}

/** Runs a debug bar request in the background. A failure goes to the Effect logger. */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

/** Keeps a measured value only when it is a number. */
const known = (n: Metric) => Option.filter(n, (value) => !Number.isNaN(value))

const ms = (n: Metric, d = 0) => Option.map(known(n), (value) => `${value.toFixed(d)}ms`)

const time = (n: Metric) => Option.map(known(n), (value) => `${Math.round(value)}`)

const mb = (n: Metric) =>
  Option.map(known(n), (value) => {
    const v = value / 1024 / 1024
    return `${v >= 1024 ? v.toFixed(0) : v.toFixed(1)}MB`
  })

const bad = (n: Metric, limit: number, low = false) =>
  Option.match(known(n), {
    onNone: () => false,
    onSome: (value) => (low ? value < limit : value > limit),
  })

/** The long-task totals after the observer starts and before the first long task. */
const noLongTasks = () => ({ block: Option.some(0), count: Option.some(0), max: Option.some(0) })

const session = (path: string) => path.includes("/session")

function Cell(props: {
  bad?: boolean
  dim?: boolean
  inline?: boolean
  label: string
  tip: string
  value: string
  span?: 2 | 3
}) {
  const content = () => (
    <div
      classList={{
        "flex min-w-0 items-center": true,
        "min-h-[20px] w-fit justify-start px-1.5 py-0.5 text-left": !!props.inline,
        "justify-center text-center": !props.inline,
        "min-h-[42px] w-full flex-col rounded-[8px] px-0.5 py-1": !props.inline,
        "col-span-2": props.span === 2 && !props.inline,
        "col-span-3": props.span === 3 && !props.inline,
      }}
    >
      <div
        classList={{
          "flex min-w-0": true,
          "-translate-y-px items-baseline gap-1.5": !!props.inline,
          "flex-col items-center": !props.inline,
        }}
      >
        <div
          classList={{
            "text-[10px] leading-none font-black uppercase tracking-[0.04em] opacity-70": true,
          }}
        >
          {props.label}
        </div>
        <div
          classList={{
            "uppercase leading-none font-bold tabular-nums": true,
            "text-[11px]": !!props.inline,
            "text-[13px] sm:text-[14px]": !props.inline,
            "text-text-on-critical-base": !!props.bad,
            "opacity-70": !!props.dim,
          }}
        >
          {props.value}
        </div>
      </div>
    </div>
  )

  if (props.inline) {
    return (
      <TooltipV2 value={props.tip} placement="top">
        {content()}
      </TooltipV2>
    )
  }

  return (
    <Tooltip value={props.tip} placement="top">
      {content()}
    </Tooltip>
  )
}

function ToggleCell(props: {
  active: boolean
  inline?: boolean
  label: string
  onClick: () => void
  tip: string
  value: string
}) {
  const content = () => (
    <button
      type="button"
      aria-label={`${props.label}: ${props.value}`}
      aria-pressed={props.active}
      classList={{
        "flex min-w-0 items-center font-mono uppercase hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus": true,
        "min-h-[20px] w-fit justify-start rounded px-1.5 py-0.5 text-left": !!props.inline,
        "min-h-[42px] w-full flex-col justify-center rounded-[8px] px-0.5 py-1 text-center": !props.inline,
        "bg-surface-raised-base text-text-strong": props.active,
      }}
      onClick={props.onClick}
    >
      <span
        classList={{
          flex: true,
          "-translate-y-px items-baseline gap-1.5": !!props.inline,
          "flex-col items-center": !props.inline,
        }}
      >
        <span class="text-[10px] leading-none font-black tracking-[0.04em] opacity-70">{props.label}</span>
        <span class="text-[11px] leading-none font-bold">{props.value}</span>
      </span>
    </button>
  )

  if (props.inline) {
    return (
      <TooltipV2 value={props.tip} placement="top">
        {content()}
      </TooltipV2>
    )
  }

  return (
    <Tooltip value={props.tip} placement="top">
      {content()}
    </Tooltip>
  )
}

export function DebugBar(props: { inline?: boolean } = {}) {
  const language = useLanguage()
  const platform = usePlatform()
  const location = useLocation()
  const routing = useIsRouting()
  const [state, setState] = createStore({
    cls: Option.none<number>(),
    delay: Option.none<number>(),
    fps: Option.none<number>(),
    gap: Option.none<number>(),
    focus: false,
    heap: {
      limit: Option.none<number>(),
      used: Option.none<number>(),
    },
    inp: Option.none<number>(),
    jank: Option.none<number>(),
    long: {
      block: Option.none<number>(),
      count: Option.none<number>(),
      max: Option.none<number>(),
    },
    nav: {
      dur: Option.none<number>(),
      pending: false,
    },
  })

  const na = () => language.t("debugBar.na").toUpperCase()
  const heap = () =>
    Option.map(
      Option.filter(state.heap.limit, (limit) => limit !== 0 && !Number.isNaN(limit)),
      (limit) => Option.getOrElse(state.heap.used, () => 0) / limit,
    )
  const heapv = () => Option.match(heap(), { onNone: na, onSome: (value) => `${Math.round(value * 100)}%` })
  const longv = () =>
    Option.match(state.long.count, {
      onNone: na,
      onSome: (count) => `${Option.getOrElse(time(state.long.block), na)}/${count}`,
    })
  const navv = () => (state.nav.pending ? "..." : Option.getOrElse(time(state.nav.dur), na))
  // The platform method is optional: without it the call returns no request, and nothing runs.
  const setForceFocus = (enabled: boolean) =>
    Effect.suspend(() =>
      Option.match(Option.fromNullishOr(platform.setForceFocus?.(enabled)), {
        onNone: () => Effect.void,
        onSome: (request) =>
          Effect.tryPromise({ try: () => request, catch: (cause) => new ForceFocusError({ cause }) }),
      }),
    )
  const toggleFocus = () => {
    if (!platform.setForceFocus) return
    const enabled = !state.focus
    runDetached(setForceFocus(enabled).pipe(Effect.andThen(Effect.sync(() => setState("focus", enabled)))))
  }

  onCleanup(() => {
    // Leaving force focus on unmount is best effort, so a rejection is ignored.
    if (state.focus) Effect.runFork(Effect.ignore(setForceFocus(false)))
  })

  let prev = ""
  let start = 0
  let init = false
  let one = 0
  let two = 0

  createEffect(() => {
    const busy = routing()
    const next = `${location.pathname}${location.search}`

    if (!init) {
      init = true
      prev = next
      return
    }

    if (busy) {
      if (one !== 0) cancelAnimationFrame(one)
      if (two !== 0) cancelAnimationFrame(two)
      one = 0
      two = 0
      if (start !== 0) return
      start = performance.now()
      if (session(prev)) setState("nav", { dur: Option.none(), pending: true })
      return
    }

    if (start === 0) {
      prev = next
      return
    }

    const at = start
    const from = prev
    start = 0
    prev = next

    if (!(session(from) || session(next))) return

    if (one !== 0) cancelAnimationFrame(one)
    if (two !== 0) cancelAnimationFrame(two)
    one = requestAnimationFrame(() => {
      one = 0
      two = requestAnimationFrame(() => {
        two = 0
        setState("nav", { dur: Option.some(performance.now() - at), pending: false })
      })
    })
  })

  onMount(() => {
    let obs = Chunk.empty<PerformanceObserver>()
    let fps = Chunk.empty<Sample>()
    let long = Chunk.empty<Sample>()
    const seen = MutableHashMap.empty<number | string, { at: number; delay: number; dur: number }>()
    let hasLong = false
    // The once-a-second refresh of the long-task, interaction and heap cells.
    const poll = createFiberSlot()
    let polling = false
    let raf = 0
    let last = 0
    let snap = 0

    /** Drops the samples that started more than `span` before `at`. */
    const trim = (samples: Chunk.Chunk<Sample>, at: number) => Chunk.dropWhile(samples, (entry) => at - entry.at > span)

    const syncFrame = (at: number) => {
      fps = trim(fps, at)
      const total = Chunk.reduce(fps, 0, (sum, entry) => sum + entry.dur)
      const gap = Chunk.reduce(fps, 0, (max, entry) => Math.max(max, entry.dur))
      const jank = Chunk.size(Chunk.filter(fps, (entry) => entry.dur > 32))
      batch(() => {
        setState("fps", total > 0 ? Option.some((Chunk.size(fps) * 1000) / total) : Option.none())
        setState("gap", gap > 0 ? Option.some(gap) : Option.none())
        setState("jank", Option.some(jank))
      })
    }

    const syncLong = (at = performance.now()) => {
      if (!hasLong) return
      long = trim(long, at)
      const block = Chunk.reduce(long, 0, (sum, entry) => sum + Math.max(0, entry.dur - 50))
      const max = Chunk.reduce(long, 0, (hi, entry) => Math.max(hi, entry.dur))
      setState("long", { block: Option.some(block), count: Option.some(Chunk.size(long)), max: Option.some(max) })
    }

    const syncInp = (at = performance.now()) => {
      for (const [key, entry] of seen) {
        if (at - entry.at > span) MutableHashMap.remove(seen, key)
      }
      let delay = 0
      let inp = 0
      for (const entry of MutableHashMap.values(seen)) {
        delay = Math.max(delay, entry.delay)
        inp = Math.max(inp, entry.dur)
      }
      batch(() => {
        setState("delay", delay > 0 ? Option.some(delay) : Option.none())
        setState("inp", inp > 0 ? Option.some(inp) : Option.none())
      })
    }

    const syncHeap = () => {
      const mem = (performance as Mem).memory
      if (!mem) return
      setState("heap", { limit: Option.some(mem.jsHeapSizeLimit), used: Option.some(mem.usedJSHeapSize) })
    }

    const reset = () => {
      fps = Chunk.empty()
      long = Chunk.empty()
      MutableHashMap.clear(seen)
      last = 0
      snap = 0
      batch(() => {
        setState("fps", Option.none())
        setState("gap", Option.none())
        setState("jank", Option.none())
        setState("delay", Option.none())
        setState("inp", Option.none())
        if (hasLong) setState("long", noLongTasks())
      })
    }

    const watch = (type: string, init: Obs, fn: (entries: PerformanceEntry[]) => void) => {
      if (typeof PerformanceObserver === "undefined") return false
      if (!(PerformanceObserver.supportedEntryTypes ?? []).includes(type)) return false
      const ob = new PerformanceObserver((list) => fn(list.getEntries()))
      // observe throws when the browser rejects the options for this entry type.
      return Result.match(
        Result.try(() => ob.observe(init)),
        {
          onSuccess: () => {
            obs = Chunk.append(obs, ob)
            return true
          },
          onFailure: () => {
            ob.disconnect()
            return false
          },
        },
      )
    }

    if (
      watch("layout-shift", { buffered: true, type: "layout-shift" }, (entries) => {
        const add = entries.filter(isShift).reduce((sum, item) => (item.hadRecentInput ? sum : sum + item.value), 0)
        if (add === 0) return
        setState("cls", (value) => Option.some(Option.getOrElse(value, () => 0) + add))
      })
    ) {
      setState("cls", Option.some(0))
    }

    if (
      watch("longtask", { buffered: true, type: "longtask" }, (entries) => {
        const at = performance.now()
        long = Chunk.appendAll(
          long,
          Chunk.fromIterable(entries.map((entry) => ({ at: entry.startTime, dur: entry.duration }))),
        )
        syncLong(at)
      })
    ) {
      hasLong = true
      setState("long", noLongTasks())
    }

    watch("event", { buffered: true, durationThreshold: 16, type: "event" }, (entries) => {
      for (const raw of entries) {
        const entry = raw as Evt
        if (entry.duration < 16) continue
        const key =
          entry.interactionId && entry.interactionId > 0
            ? entry.interactionId
            : `${entry.name}:${Math.round(entry.startTime)}`
        const prev = Option.getOrElse(MutableHashMap.get(seen, key), () => ({ delay: 0, dur: 0 }))
        const delay = Math.max(0, (entry.processingStart ?? entry.startTime) - entry.startTime)
        MutableHashMap.set(seen, key, {
          at: entry.startTime,
          delay: Math.max(prev.delay, delay),
          dur: Math.max(prev.dur, entry.duration),
        })
        if (MutableHashMap.size(seen) <= 200) continue
        // Primitive keys keep insertion order, so the first key is the oldest interaction.
        const first = MutableHashMap.keys(seen)[Symbol.iterator]().next()
        if (!first.done) MutableHashMap.remove(seen, first.value)
      }
      syncInp()
    })

    const loop = (at: number) => {
      if (document.visibilityState !== "visible") {
        raf = 0
        return
      }

      if (last === 0) {
        last = at
        raf = requestAnimationFrame(loop)
        return
      }

      fps = Chunk.append(fps, { at, dur: at - last })
      last = at

      if (at - snap >= 250) {
        snap = at
        syncFrame(at)
      }

      raf = requestAnimationFrame(loop)
    }

    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      if (!polling) return
      poll.interrupt()
      polling = false
    }

    const start = () => {
      if (document.visibilityState !== "visible") return
      if (!polling) {
        polling = true
        const refresh = Effect.sync(() => {
          syncLong()
          syncInp()
          syncHeap()
        })
        // Like setInterval, the first refresh runs one second after the start.
        poll.run(refresh.pipe(Effect.delay("1 second"), Effect.forever))
      }
      if (raf !== 0) return
      raf = requestAnimationFrame(loop)
    }

    const vis = () => {
      if (document.visibilityState !== "visible") {
        stop()
        return
      }
      reset()
      start()
    }

    syncHeap()
    start()
    makeEventListener(document, "visibilitychange", vis)

    onCleanup(() => {
      if (one !== 0) cancelAnimationFrame(one)
      if (two !== 0) cancelAnimationFrame(two)
      stop()
      for (const ob of obs) ob.disconnect()
    })
  })

  return (
    <aside
      aria-label={language.t("debugBar.ariaLabel")}
      classList={{
        "pointer-events-auto hidden overflow-hidden text-text-strong md:block": true,
        "mt-[-6px] w-full shrink-0 px-3 py-1": !!props.inline,
        "fixed bottom-3 right-3 z-50 w-[308px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border-base bg-surface-raised-stronger-non-alpha p-0.5 shadow-[var(--shadow-lg-border-base)] sm:bottom-4 sm:right-4 sm:w-[324px]":
          !props.inline,
      }}
    >
      <div
        classList={{
          "font-mono": true,
          "gap-[9px]": !!props.inline,
          "gap-px": !props.inline,
          "flex w-full flex-nowrap items-center justify-start": !!props.inline,
          "grid-cols-4": !props.inline,
          grid: !props.inline,
        }}
      >
        <Cell
          label={language.t("debugBar.nav.label")}
          tip={language.t("debugBar.nav.tip")}
          value={navv()}
          bad={bad(state.nav.dur, 400)}
          dim={Option.isNone(state.nav.dur) && !state.nav.pending}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.fps.label")}
          tip={language.t("debugBar.fps.tip")}
          value={Option.match(state.fps, { onNone: na, onSome: (fps) => `${Math.round(fps)}` })}
          bad={bad(state.fps, 50, true)}
          dim={Option.isNone(state.fps)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.frame.label")}
          tip={language.t("debugBar.frame.tip")}
          value={Option.getOrElse(time(state.gap), na)}
          bad={bad(state.gap, 50)}
          dim={Option.isNone(state.gap)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.jank.label")}
          tip={language.t("debugBar.jank.tip")}
          value={Option.match(state.jank, { onNone: na, onSome: (jank) => `${jank}` })}
          bad={bad(state.jank, 8)}
          dim={Option.isNone(state.jank)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.long.label")}
          tip={language.t("debugBar.long.tip", { max: Option.getOrElse(ms(state.long.max), na) })}
          value={longv()}
          bad={bad(state.long.block, 200)}
          dim={Option.isNone(state.long.count)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.delay.label")}
          tip={language.t("debugBar.delay.tip")}
          value={Option.getOrElse(time(state.delay), na)}
          bad={bad(state.delay, 100)}
          dim={Option.isNone(state.delay)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.inp.label")}
          tip={language.t("debugBar.inp.tip")}
          value={Option.getOrElse(time(state.inp), na)}
          bad={bad(state.inp, 200)}
          dim={Option.isNone(state.inp)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.cls.label")}
          tip={language.t("debugBar.cls.tip")}
          value={Option.match(state.cls, { onNone: na, onSome: (cls) => cls.toFixed(2) })}
          bad={bad(state.cls, 0.1)}
          dim={Option.isNone(state.cls)}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.mem.label")}
          tip={
            Option.isNone(state.heap.used)
              ? language.t("debugBar.mem.tipUnavailable")
              : language.t("debugBar.mem.tip", {
                  used: Option.getOrElse(mb(state.heap.used), na),
                  limit: Option.getOrElse(mb(state.heap.limit), na),
                })
          }
          value={heapv()}
          bad={bad(heap(), 0.8)}
          dim={Option.isNone(state.heap.used)}
          inline={props.inline}
          span={platform.setForceFocus ? 2 : 3}
        />
        <ToggleCell
          active={language.direction() === "rtl"}
          inline={props.inline}
          label={language.t("debugBar.direction.label")}
          tip={language.t("debugBar.direction.tip")}
          value={language.t(`debugBar.direction.${language.direction()}`)}
          onClick={() => language.setDirection(language.direction() === "rtl" ? "ltr" : "rtl")}
        />
        {platform.setForceFocus && (
          <ToggleCell
            active={state.focus}
            inline={props.inline}
            label={language.t("debugBar.focus.label")}
            tip={language.t("debugBar.focus.tip")}
            value={language.t(state.focus ? "debugBar.focus.on" : "debugBar.focus.off")}
            onClick={toggleFocus}
          />
        )}
      </div>
    </aside>
  )
}
