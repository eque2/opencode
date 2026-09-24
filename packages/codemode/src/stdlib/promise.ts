import { HashSet } from "effect"

const promiseMethodNames = ["all", "allSettled", "race", "resolve", "reject"] as const

/** A Promise static a program may call. */
export type PromiseMethodName = (typeof promiseMethodNames)[number]

export const promiseStatics = HashSet.make(...promiseMethodNames)

export const isPromiseMethodName = (key: string): key is PromiseMethodName => HashSet.has(promiseStatics, key)

/** Maximum number of eagerly forked tool calls that may run concurrently. */
export const TOOL_CALL_CONCURRENCY = 8
