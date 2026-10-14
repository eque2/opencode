import type { BlendModel } from "@/task/blend/model"

// The task harness's state and the facts that move it. The engine (`@/task/engine-xstate`) folds the facts through
// the run machine of the plan; `State` is only the shape its `view` selector reads out of the snapshot. The runner
// (`@/task/core/runner`) records each fact as a durable EventV2 event and never changes state any other way, so a
// resume is the same fold over the stored events.

export type RunState =
  | "running"
  | "refused"
  | "waiting"
  | "done"
  | "cancelled"
  | "needs_human"
  | "budget_exhausted"
  | "failed"
export type TaskState =
  | "waiting"
  | "building"
  | "proving"
  | "verifying"
  | "trusted"
  | "stalled"
  | "needs_human"
  | "budget_exhausted"
  | "cancelled"
  | "failed"
  | "blocked"
export type ObligationState = "pending" | "passed" | "failed" | "trusted" | "rejected" | "stale"
export type ScenarioState =
  | "waiting"
  | "pending"
  | "verifying"
  | "trusted"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled"

export interface History {
  readonly at: number
  readonly unit: string
  readonly from?: string
  readonly to: string
  readonly reason?: string
}

export interface TaskModel {
  readonly id: string
  readonly leaf: boolean
  readonly state: TaskState
  /** Returns to the builder: 1 for the first build; parents stay 0 until reviewed, then 1. */
  readonly attempts: number
  readonly worktree?: string
  readonly branch?: string
  /** The main-branch commit the task's branch started from. */
  readonly base?: string
  /** The task's last ready commit. */
  readonly head?: string
  /** The builder session, kept across attempts. */
  readonly session?: string
  readonly reason?: string
}

export interface ObligationModel {
  readonly id: string
  readonly task: string
  readonly state: ObligationState
  readonly hash: string
  readonly reason?: string
}

export interface ScenarioModel {
  readonly id: string
  readonly state: ScenarioState
  readonly reason?: string
}

export interface State {
  readonly run: { readonly state: RunState; readonly reason?: string; readonly spec: string; readonly path: string }
  readonly tasks: Readonly<Record<string, TaskModel>>
  readonly obligations: Readonly<Record<string, ObligationModel>>
  readonly scenarios: Readonly<Record<string, ScenarioModel>>
  readonly history: ReadonlyArray<History>
}

export type Verdict = { readonly id: string; readonly verdict: "trusted" | "rejected"; readonly reason?: string }
export type Result = {
  readonly id: string
  readonly status: "passed" | "failed" | "needs-judge"
  readonly reason?: string
}

/**
 * The facts. Each is one durable event. `at` is the time the runner recorded it. The engine decides every state
 * change from these alone; a fact that does not apply in the current state is ignored (and leaves no history).
 */
export type Fact =
  /** `base`: the branch the leaves branch from and merge into; absent in runs stored before it was recorded. */
  | { readonly type: "run.started"; readonly at: number; readonly base?: string }
  | { readonly type: "run.resumed"; readonly at: number; readonly base?: string }
  /** An `outside` precondition the state store records as trusted. */
  | { readonly type: "outside.trusted"; readonly at: number; readonly id: string }
  | {
      readonly type: "task.started"
      readonly at: number
      readonly task: string
      readonly worktree: string
      readonly branch: string
      readonly base: string
      readonly session: string
    }
  | { readonly type: "task.ready"; readonly at: number; readonly task: string; readonly head: string }
  /** Machine proof results of the obligations the round proved; anything failed sends the task back to the builder. */
  | {
      readonly type: "task.proved"
      readonly at: number
      readonly task: string
      readonly results: ReadonlyArray<Result>
      readonly reason?: string
    }
  /** Verdicts of a verifier or reviewer round; the runner records this only after a passing merge, if any. */
  | {
      readonly type: "task.verified"
      readonly at: number
      readonly task: string
      readonly verdicts: ReadonlyArray<Verdict>
    }
  /** The builder's stream stalled; the runner cut it and prompts the same attempt again. */
  | { readonly type: "task.stalled"; readonly at: number; readonly task: string; readonly reason: string }
  /** The builder repeated one call; the turn was ended and the task goes back to the builder. */
  | { readonly type: "task.repeated"; readonly at: number; readonly task: string; readonly reason: string }
  | { readonly type: "task.needs_human"; readonly at: number; readonly task: string; readonly reason: string }
  | { readonly type: "task.failed"; readonly at: number; readonly task: string; readonly reason: string }
  /** An obligation's unit hash changed after it was judged: prove and judge it again. */
  | { readonly type: "obligation.stale"; readonly at: number; readonly id: string; readonly hash: string }
  | {
      readonly type: "scenario.proved"
      readonly at: number
      readonly id: string
      readonly status: "passed" | "failed"
      readonly reason?: string
    }
  | { readonly type: "scenario.verified"; readonly at: number; readonly verdict: Verdict }
  | { readonly type: "run.cancelled"; readonly at: number; readonly reason: string }
  | { readonly type: "run.ended"; readonly at: number; readonly state: "done" | "failed"; readonly reason?: string }

/** What an engine needs to build the first state of a run. */
export interface Plan {
  readonly spec: BlendModel.Spec
  /** The spec folder, relative to the session directory, and the `/task` path. */
  readonly specPath: string
  readonly path: string
  /** The tasks under the path (a parent and its leaves). */
  readonly tasks: ReadonlyArray<BlendModel.Task>
  /** The scenarios whose `needs` are all under the path or `outside`. */
  readonly scenarios: ReadonlyArray<BlendModel.Scenario>
  /** The folder tasks outside the path that a task under it is after (a subtree run), in natural order. */
  readonly external: ReadonlyArray<string>
  /** `policy.budgets.taskAttempts` of each task's effective policy. */
  readonly budget: (task: string) => number
}

export * as TaskCoreModel from "./model"
