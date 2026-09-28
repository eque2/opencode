import { MutableHashMap, Option } from "effect"

export function createUpdaterSubscriptions() {
  const subscriptions = MutableHashMap.empty<number, () => void>()

  const remove = (id: number) => {
    const unsubscribe = MutableHashMap.get(subscriptions, id)
    if (Option.isSome(unsubscribe)) unsubscribe.value()
    MutableHashMap.remove(subscriptions, id)
  }

  return {
    set(id: number, unsubscribe: () => void) {
      remove(id)
      MutableHashMap.set(subscriptions, id, unsubscribe)
    },
    delete: remove,
    clear() {
      MutableHashMap.forEach(subscriptions, (unsubscribe) => unsubscribe())
      MutableHashMap.clear(subscriptions)
    },
  }
}
