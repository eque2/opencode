import { Deferred, Effect, MutableList, Schema } from "effect"

export const TuiRequest = Schema.Struct({
  path: Schema.String,
  // eslint-disable-next-line effect/no-schema-any-unknown -- (b) foreign value domain: an opaque request body relayed to the TUI as is
  body: Schema.Unknown,
}).annotate({ description: "Request that the server sends to the TUI" })

export type TuiRequest = Schema.Schema.Type<typeof TuiRequest>

// Process-global mailboxes. Effect Queue needs a running fiber to be made, and these exist at module
// load, so each mailbox keeps its unread items and its waiting takers in MutableLists.
type Mailbox<A> = {
  readonly items: MutableList.MutableList<A>
  readonly takers: MutableList.MutableList<Deferred.Deferred<A>>
}

const mailbox = <A>(): Mailbox<A> => ({ items: MutableList.make(), takers: MutableList.make() })

const put = <A>(box: Mailbox<A>, item: A) => {
  const taker = MutableList.take(box.takers)
  if (taker === MutableList.Empty) return MutableList.append(box.items, item)
  Deferred.doneUnsafe(taker, Effect.succeed(item))
}

// An interrupted take removes its taker, so a later put goes to the next taker or the items.
const take = <A>(box: Mailbox<A>) =>
  Effect.suspend(() => {
    const item = MutableList.take(box.items)
    if (item !== MutableList.Empty) return Effect.succeed(item)
    const taker = Deferred.makeUnsafe<A>()
    MutableList.append(box.takers, taker)
    return Deferred.await(taker).pipe(Effect.onInterrupt(() => Effect.sync(() => MutableList.remove(box.takers, taker))))
  })

const request = mailbox<TuiRequest>()
const response = mailbox<unknown>()

export function nextTuiRequest() {
  return Effect.runPromise(take(request))
}

export function submitTuiRequest(body: TuiRequest) {
  put(request, body)
}

export function submitTuiResponse(body: unknown) {
  put(response, body)
}

export function nextTuiResponse() {
  return Effect.runPromise(take(response))
}
