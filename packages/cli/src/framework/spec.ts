import * as Command from "effect/unstable/cli/Command"

type Options<Commands extends ReadonlyArray<Any>> = {
  readonly description?: string
  readonly commands?: Commands
}

export interface Node<
  Name extends string,
  Spec extends Command.Command<Name, any, any, any, any>,
  Commands extends Children,
> {
  readonly name: Name
  readonly spec: Spec
  readonly commands: Commands
}

export type Any = Node<string, Command.Command<any, any, any, any, any>, Children>
export type Children = Readonly<Record<string, Any>>

type Made<Name extends string, Input, Commands extends ReadonlyArray<Any>> = {
  name: Name
  spec: Command.Command<Name, Input>
  commands: ChildrenOf<Commands>
}

export function make<
  const Name extends string,
  const Config extends Command.Command.Config,
  const Commands extends ReadonlyArray<Any> = [],
>(
  name: Name,
  options: Options<Commands> & { readonly params: Config },
): Made<Name, Command.Command.Config.Infer<Config>, Commands>
export function make<const Name extends string, const Commands extends ReadonlyArray<Any> = []>(
  name: Name,
  options?: Options<Commands> & { readonly params?: undefined },
): Made<Name, {}, Commands>
export function make<const Name extends string, const Commands extends ReadonlyArray<Any>>(
  name: Name,
  options: Options<Commands> & { readonly params?: Command.Command.Config } = {},
) {
  return options.params === undefined
    ? node(name, Command.make(name), options)
    : node(name, Command.make(name, options.params), options)
}

function node<Name extends string, Input, Commands extends ReadonlyArray<Any>>(
  name: Name,
  command: Command.Command<Name, Input>,
  options: Options<Commands>,
): Made<Name, Input, Commands> {
  return {
    name,
    spec: options.description ? command.pipe(Command.withDescription(options.description)) : command,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- (a) Object.fromEntries lib signature returns { [k: string]: T } and drops the literal key of each node
    commands: Object.fromEntries(
      (options.commands ?? []).map((command) => [command.name, command]),
    ) as ChildrenOf<Commands>,
  }
}

type ChildrenOf<Commands extends ReadonlyArray<Any>> = {
  readonly [Node in Commands[number] as Node["name"]]: Node
}

export * as Spec from "./spec"
