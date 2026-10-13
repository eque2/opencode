// The entry point of the task harness: `/task` (`./command`). The runner, its store and its projection
// live beside it (`./runner`, `./events`, `./status`); the fixed interfaces are `./model`, `./hooks` and `./ops`.

export { run, type CommandInput } from "./command"

export * as TaskCore from "."
