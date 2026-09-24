import { Array, Brand, Context, Effect, Layer, MutableHashMap, MutableHashSet, Option, Result, Schema } from "effect"

type AnyNode = Node<unknown, unknown, any>
type RuntimeLayer = Layer.Layer<never, unknown, unknown>
type NodeList<Item extends AnyNode = AnyNode> = readonly [] | readonly [Item, ...Item[]]
export type Output<Item> = [Item] extends [never] ? never : Item extends Node<infer A, unknown, any> ? A : never
export type Error<Item> = [Item] extends [never] ? never : Item extends Node<unknown, infer E, any> ? E : never
type NodeTag<Item> = [Item] extends [never] ? undefined : Item extends Node<unknown, unknown, infer T> ? T : never
type Missing<Required, Dependencies extends NodeList> = Exclude<Required, Output<Dependencies[number]>>
type CheckDependencies<Implementation extends Layer.Any, Dependencies extends NodeList> = [
  Missing<Layer.Services<Implementation>, Dependencies>,
] extends [never]
  ? unknown
  : { readonly "Missing dependencies": Missing<Layer.Services<Implementation>, Dependencies> }
declare const $OutputType: unique symbol
declare const $ErrorType: unique symbol

export type Tag<Name extends string = string> = Name & Brand.Brand<"LayerNode.Tag">

const makeTag = Brand.nominal<Tag>()

export interface Node<A, E = never, T extends Tag | undefined = undefined> {
  readonly kind: "layer" | "unbound" | "group"
  readonly name: string
  readonly service?: Context.Service.Any
  readonly implementation?: Layer.Any
  readonly dependencies: readonly AnyNode[]
  readonly tag?: T
  readonly [$OutputType]?: () => A
  readonly [$ErrorType]?: () => E
}

/** A placeholder node that a replacement must bind before the graph compiles. */
export interface UnboundNode<A, T extends Tag = Tag> extends Node<A, never, T> {
  readonly kind: "unbound"
}

/**
 * A layer graph that cannot compile: a dependency cycle, an unbound node, an invalid
 * replacement, or conflicting hoisted implementations. The compiled layer dies with it.
 */
export class GraphError extends Schema.TaggedError<GraphError>()("LayerNode.GraphError", {
  message: Schema.String,
}) {}

const graphError = (message: string) => Result.fail(new GraphError({ message }))

type NodeIdentity =
  | { readonly service: Context.Service.Any; readonly name?: never }
  | { readonly name: string; readonly service?: never }
type DistributiveOmit<A, K extends PropertyKey> = A extends unknown ? Omit<A, K> : never

export type TagConfig = Readonly<Record<string, readonly string[]>>
type TagNames<Config extends TagConfig> = keyof Config & string
type NodeInTags<Names extends string> = Node<unknown, unknown, Tag<Names> | undefined>
type CheckTags<Items extends NodeList, Names extends string> = [Exclude<Items[number], NodeInTags<Names>>] extends [
  never,
]
  ? unknown
  : { readonly "Invalid tag dependencies": Exclude<Items[number], NodeInTags<Names>> }

export interface Tags<Config extends TagConfig> {
  readonly values: { readonly [Name in TagNames<Config>]: Tag<Name> }
  readonly make: <Name extends TagNames<Config>>(
    name: Name,
  ) => <const Implementation extends Layer.Any, const Items extends NodeList>(
    input: DistributiveOmit<MakeInput<Implementation, Items, Tag<Name>>, "tag"> &
      CheckTags<Items, Name | Extract<Config[Name][number], string>>,
  ) => Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, Tag<Name>>
}

export function tags<const Config extends { readonly [Name in keyof Config]: readonly (keyof Config & string)[] }>(
  config: Config,
): Tags<Config> {
  const names = Object.keys(config) as TagNames<Config>[]
  const values = Object.fromEntries(names.map((name) => [name, makeTag(name)])) as Tags<Config>["values"]
  return {
    values,
    make: ((name: TagNames<Config>) => (input: DistributiveOmit<MakeInput<Layer.Any, NodeList, Tag>, "tag">) =>
      make({ ...input, tag: values[name] })) as Tags<Config>["make"],
  }
}

// Nodes ---------------------------------------------------------------------

type MakeInput<
  Implementation extends Layer.Any,
  Items extends NodeList,
  T extends Tag | undefined = undefined,
> = NodeIdentity & {
  readonly layer: Implementation
  readonly deps: Items & CheckDependencies<Implementation, NoInfer<Items>>
  readonly tag?: T
}

export function make<
  const Implementation extends Layer.Any,
  const Items extends NodeList,
  const T extends Tag | undefined = undefined,
>(
  input: MakeInput<Implementation, Items, T>,
): Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, T> {
  return {
    kind: "layer",
    name: input.service !== undefined ? input.service.key : input.name,
    service: input.service,
    implementation: input.layer,
    dependencies: input.deps,
    tag: input.tag,
  }
}

export function unbound<R, Shape, const T extends Tag>(service: Context.Key<R, Shape>, tag: T): UnboundNode<R, T> {
  return {
    kind: "unbound",
    name: service.key,
    service,
    dependencies: [],
    tag,
  }
}

export function group<const Items extends readonly AnyNode[]>(
  dependencies: Items,
): Node<Output<Items[number]>, Error<Items[number]>, NodeTag<Items[number]>> {
  return { kind: "group", name: "group", dependencies }
}

export type Replacement = readonly [source: AnyNode, replacement: AnyNode | Layer.Any]
export type Replacements = readonly Replacement[]

type CheckReplacementErrors<SourceError, ReplacementError> = [Exclude<ReplacementError, SourceError>] extends [never]
  ? unknown
  : { readonly "New replacement errors": Exclude<ReplacementError, SourceError> }

type CheckReplacement<Item> = Item extends readonly [Node<infer A, infer E, infer T>, infer Replacement]
  ? Replacement extends Node<NoInfer<A>, infer E2, T>
    ? CheckReplacementErrors<E, NoInfer<E2>>
    : Replacement extends Layer.Layer<NoInfer<A>, infer E2>
      ? CheckReplacementErrors<E, NoInfer<E2>>
      : { readonly "Invalid replacement": Replacement }
  : { readonly "Invalid replacement": Item }

type CheckReplacements<Items extends Replacements> = {
  readonly [K in keyof Items]: CheckReplacement<Items[K]>
}

type ValidReplacements<Items extends Replacements> = Items & CheckReplacements<Items>

function replacementNode(source: AnyNode, replacement: AnyNode | Layer.Any): Result.Result<AnyNode, GraphError> {
  const node = isNode(replacement)
    ? replacement
    : make({
        ...nodeMakeIdentity(source),
        layer: replacement as Layer.Layer<unknown, unknown>,
        deps: [],
        tag: source.tag,
      })
  if (source.name !== node.name) return graphError(`Cannot replace ${source.name} with ${node.name}`)
  if (source.tag !== node.tag) return graphError(`Cannot replace ${source.name} across tags`)
  return Result.succeed(node)
}

function nodeMakeIdentity(node: AnyNode): NodeIdentity {
  if (node.service !== undefined) return { service: node.service }
  return { name: node.name }
}

function isNode(input: Layer.Any | AnyNode): input is AnyNode {
  return "kind" in input && "dependencies" in input
}

// A node whose layer dies with the graph error, so an invalid graph still has the node shape.
function failedNode(error: GraphError): Node<never> {
  return {
    kind: "layer",
    name: error._tag,
    implementation: Layer.effectDiscard(Effect.die(error)),
    dependencies: [],
  }
}

// Tree -----------------------------------------------------------------------

type Visit<Out> = (node: AnyNode, context: VisitContext<Out>) => Result.Result<Out, GraphError>

type VisitContext<Out> = {
  readonly cache: MutableHashMap.MutableHashMap<AnyNode, Out>
  readonly visit: (node: AnyNode) => Result.Result<Out, GraphError>
}

function walk<Out>(
  root: AnyNode,
  visit: Visit<Out>,
  options: {
    readonly cache?: MutableHashMap.MutableHashMap<AnyNode, Out>
    readonly resolve?: (node: AnyNode) => AnyNode
  } = {},
): Result.Result<Out, GraphError> {
  const cache = options.cache ?? MutableHashMap.empty<AnyNode, Out>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode): Result.Result<Out, GraphError> => {
    const target = options.resolve?.(node) ?? node
    const cached = MutableHashMap.get(cache, target)
    if (Option.isSome(cached)) return Result.succeed(cached.value)
    if (stack.includes(target)) return cycle(stack, target)

    stack.push(target)
    const result = visit(target, { cache, visit: recur })
    stack.pop()
    if (Result.isSuccess(result) && !MutableHashMap.has(cache, target)) MutableHashMap.set(cache, target, result.success)
    return result
  }

  return recur(root)
}

function cycle(stack: readonly AnyNode[], target: AnyNode) {
  const path = [...stack.slice(stack.indexOf(target)), target]
  return graphError(`Cycle detected in layer tree: ${path.map((item) => item.name).join(" -> ")}`)
}

function visitAll<Out>(nodes: readonly AnyNode[], visit: (node: AnyNode) => Result.Result<Out, GraphError>) {
  return Result.all(nodes.map(visit))
}

export function hoist<A, E, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  tag: Tag,
  replacements?: ValidReplacements<Items>,
): {
  readonly node: Node<A, E>
  readonly hoisted: Node<unknown, E>
} {
  const result = hoistGraph(root, tag, replacements)
  if (Result.isFailure(result)) {
    const failed = failedNode(result.failure)
    return { node: failed, hoisted: failed }
  }
  return {
    node: result.success.node as Node<A, E>,
    hoisted: result.success.hoisted as Node<unknown, E>,
  }
}

function hoistGraph(root: AnyNode, tag: Tag, replacements: Replacements = []) {
  return Result.gen(function* () {
    const replacementMap = yield* replacementMapFrom(replacements)
    const hoisted = MutableHashMap.empty<string, AnyNode>()

    const node = yield* walk<AnyNode>(
      root,
      (node, context) =>
        Result.gen(function* () {
          if (node.kind === "group") {
            return { ...node, dependencies: yield* visitAll(node.dependencies, context.visit) }
          }
          if (node.tag === tag) {
            const existing = MutableHashMap.get(hoisted, node.name)
            if (Option.isSome(existing) && existing.value !== node) {
              return yield* graphError(`Tag ${tag} has conflicting implementations for ${node.name}`)
            }
            MutableHashMap.set(hoisted, node.name, yield* rewriteReplacementDependencies(node, replacementMap))
            return group([])
          }
          if (node.kind === "unbound") {
            return node
          }
          return { ...node, dependencies: yield* visitAll(node.dependencies, context.visit) }
        }),
      { resolve: (node) => resolveReplacement(replacementMap, node) },
    )

    return { node, hoisted: group(Array.fromIterable(MutableHashMap.values(hoisted))) }
  })
}

export function compile<A, E, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  replacements?: ValidReplacements<Items>,
): Layer.Layer<A, E> {
  // The graph compiles when the layer is built, so an invalid graph is a defect of the build.
  return Layer.suspend(() => {
    const result = compileGraph(root, replacements)
    if (Result.isFailure(result)) return Layer.effectContext(Effect.die(result.failure))
    return result.success as Layer.Layer<A, E>
  })
}

function compileGraph(root: AnyNode, replacements: Replacements = []) {
  return Result.gen(function* () {
    const replacementMap = yield* replacementMapFrom(replacements)
    const cache = MutableHashMap.empty<AnyNode, RuntimeLayer>()
    const compileNode = (node: AnyNode) =>
      walk<RuntimeLayer>(
        node,
        (node, context) =>
          Result.gen(function* () {
            if (node.kind === "unbound") return yield* graphError(`Unbound layer node: ${node.name}`)
            const dependencies = yield* visitAll(node.dependencies.flatMap(flatten), context.visit)
            const implementation = node.implementation! as RuntimeLayer
            return dependencies.length === 0
              ? implementation
              : implementation.pipe(Layer.provide(dependencies as [RuntimeLayer, ...RuntimeLayer[]]))
          }),
        { cache, resolve: (node) => resolveReplacement(replacementMap, node) },
      )
    const layers = yield* visitAll(flatten(root), compileNode)
    return layers.reduce<RuntimeLayer>((result, layer) => layer.pipe(Layer.provideMerge(result)), Layer.empty)
  })
}

function resolveReplacement(replacements: MutableHashMap.MutableHashMap<string, AnyNode>, node: AnyNode) {
  return Option.getOrElse(MutableHashMap.get(replacements, node.name), () => node)
}

function replacementMapFrom(replacements: Replacements = []) {
  return Result.gen(function* () {
    const map = MutableHashMap.empty<string, AnyNode>()
    for (const [source, replacement] of replacements) {
      const normalized = yield* rewriteReplacementDependencies(yield* replacementNode(source, replacement), map)
      const current = MutableHashMap.make([source.name, normalized])
      for (const [name, node] of map) MutableHashMap.set(map, name, yield* rewriteReplacementDependencies(node, current))
      MutableHashMap.set(map, source.name, normalized)
    }
    return map
  })
}

function rewriteReplacementDependencies(
  root: AnyNode,
  replacements: MutableHashMap.MutableHashMap<string, AnyNode>,
): Result.Result<AnyNode, GraphError> {
  if (MutableHashMap.isEmpty(replacements)) return Result.succeed(root)
  const cache = MutableHashMap.empty<AnyNode, AnyNode>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode, isRoot = false): Result.Result<AnyNode, GraphError> => {
    const target = isRoot ? node : resolveReplacement(replacements, node)
    const cached = MutableHashMap.get(cache, target)
    if (Option.isSome(cached)) return Result.succeed(cached.value)
    if (stack.includes(target)) return cycle(stack, target)

    stack.push(target)
    const dependencies = visitAll(target.dependencies, (dependency) => recur(dependency))
    stack.pop()
    return Result.map(dependencies, (dependencies) => {
      const result = dependencies.every((dependency, index) => dependency === target.dependencies[index])
        ? target
        : { ...target, dependencies }
      MutableHashMap.set(cache, target, result)
      return result
    })
  }

  return recur(root, true)
}

export function hasUnbound(root: Node<unknown, unknown, any>, source: UnboundNode<unknown>): boolean {
  const visited = MutableHashSet.empty<AnyNode>()
  const reaches = (node: AnyNode): boolean => {
    if (node === source) return true
    if (MutableHashSet.has(visited, node)) return false
    MutableHashSet.add(visited, node)
    return node.dependencies.some(reaches)
  }
  return reaches(root)
}

function flatten(node: AnyNode): readonly AnyNode[] {
  return node.kind === "group" ? node.dependencies.flatMap(flatten) : [node]
}

export * as LayerNode from "./layer-node"
