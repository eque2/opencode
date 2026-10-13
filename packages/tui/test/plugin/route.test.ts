import { expect, test } from "bun:test"
import type { Route, RouteContext } from "../../src/context/route"
import { routeCurrent, routeNavigate } from "../../src/plugin/adapters"

// A route context over a plain value: navigate replaces it, as the route store does.
function route(initial: Route): RouteContext {
  let data = initial
  return {
    get data() {
      return data
    },
    navigate(next) {
      data = next
    },
  }
}

test("a plugin's session route keeps its watch through navigate and current", () => {
  const current = route({ type: "home" })
  routeNavigate(current, "session", { sessionID: "ses_root", watch: "ses_builder" })
  expect(current.data).toEqual({ type: "session", sessionID: "ses_root", watch: "ses_builder" })
  expect(routeCurrent(current)).toEqual({ name: "session", params: { sessionID: "ses_root", watch: "ses_builder" } })
})

test("navigating without watch, or with a watch that is not a session ID, leaves the session unwatched", () => {
  const current = route({ type: "session", sessionID: "ses_root", watch: "ses_builder" })
  routeNavigate(current, "session", { sessionID: "ses_root" })
  expect(current.data).toEqual({ type: "session", sessionID: "ses_root" })
  routeNavigate(current, "session", { sessionID: "ses_root", watch: 7 })
  expect(current.data).toEqual({ type: "session", sessionID: "ses_root" })
  const params = routeCurrent(current)
  expect("params" in params ? params.params?.watch : "absent").toBeUndefined()
})
