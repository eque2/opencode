// The entry point of the task harness: `/task` (`./command`). The harness root, the Recorder, the workers and the
// supervisors run the run (`./harness`, `./recorder`, `./workers`, `./supervise`); its store and projection live
// beside them (`./events`, `./status`); the fixed interfaces are `./model`, `./hooks` and `./ops`.

export { run, type CommandInput } from "./command"

export * as TaskCore from "."
