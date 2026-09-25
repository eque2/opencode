import { Chunk } from "effect"

export function terminalWriter(
  write: (data: string, done?: VoidFunction) => void,
  schedule: (flush: VoidFunction) => void = queueMicrotask,
) {
  let chunks = Chunk.empty<string>()
  let waits = Chunk.empty<VoidFunction>()
  let scheduled = false
  let writing = false

  const settle = () => {
    if (scheduled || writing || Chunk.isNonEmpty(chunks)) return
    const list = waits
    if (Chunk.isEmpty(list)) return
    waits = Chunk.empty()
    for (const fn of list) {
      fn()
    }
  }

  const run = () => {
    if (writing) return
    scheduled = false
    const items = chunks
    if (Chunk.isEmpty(items)) {
      settle()
      return
    }
    chunks = Chunk.empty()
    writing = true
    write(Chunk.join(items, ""), () => {
      writing = false
      if (Chunk.isNonEmpty(chunks)) {
        if (scheduled) return
        scheduled = true
        schedule(run)
        return
      }
      settle()
    })
  }

  const push = (data: string) => {
    if (!data) return
    chunks = Chunk.append(chunks, data)

    if (scheduled || writing) return
    scheduled = true
    schedule(run)
  }

  const flush = (done?: VoidFunction) => {
    if (!scheduled && !writing && Chunk.isEmpty(chunks)) {
      done?.()
      return
    }
    if (done) waits = Chunk.append(waits, done)
    run()
  }

  return { push, flush }
}
