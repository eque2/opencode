import { Context } from "./context"
import { UserRole } from "./schema/user.sql"
import { Log } from "./util/log"

export namespace Actor {
  interface Account {
    type: "account"
    properties: {
      accountID: string
      email: string
    }
  }

  interface Public {
    type: "public"
    properties: {}
  }

  interface User {
    type: "user"
    properties: {
      userID: string
      workspaceID: string
      accountID: string
      role: (typeof UserRole)[number]
    }
  }

  interface System {
    type: "system"
    properties: {
      workspaceID: string
    }
  }

  export type Info = Account | Public | User | System

  type Properties = { [I in Info as I["type"]]: I["properties"] }

  // Indexed by a generic actor type, this mapped type keeps the type and its properties correlated.
  const build: { [K in keyof Properties]: (properties: Properties[K]) => Info } = {
    account: (properties) => ({ type: "account", properties }),
    public: (properties) => ({ type: "public", properties }),
    user: (properties) => ({ type: "user", properties }),
    system: (properties) => ({ type: "system", properties }),
  }

  const ctx = Context.create<Info>()
  export const use = ctx.use

  const log = Log.create().tag("namespace", "actor")

  export function provide<R, T extends Info["type"]>(
    type: T,
    properties: Properties[T],
    cb: () => R,
  ) {
    return ctx.provide(
      build[type](properties),
      () => {
        return Log.provide({ ...properties }, () => {
          log.info("provided")
          return cb()
        })
      },
    )
  }

  function isType<T extends Info["type"]>(actor: Info, type: T): actor is Extract<Info, { type: T }> {
    return actor.type === type
  }

  export function assert<T extends Info["type"]>(type: T) {
    const actor = use()
    if (!isType(actor, type)) {
      throw new Error(`Expected actor type ${type}, got ${actor.type}`)
    }
    return actor
  }

  export const assertAdmin = () => {
    if (userRole() === "admin") return
    throw new Error(`Action not allowed. Ask your workspace admin to perform this action.`)
  }

  export function workspace() {
    const actor = use()
    if ("workspaceID" in actor.properties) {
      return actor.properties.workspaceID
    }
    throw new Error(`actor of type "${actor.type}" is not associated with a workspace`)
  }

  export function account() {
    const actor = use()
    if ("accountID" in actor.properties) {
      return actor.properties.accountID
    }
    throw new Error(`actor of type "${actor.type}" is not associated with an account`)
  }

  export function userID() {
    return Actor.assert("user").properties.userID
  }

  export function userRole() {
    return Actor.assert("user").properties.role
  }
}
