export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, MutableHashMap, Option, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "SkillV2.Frontmatter" })
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

/** Parses one skill markdown file. A file without frontmatter or a usable name is not a skill. */
const parseSkill = (directory: string, filepath: string, content: string): Option.Option<Info> =>
  Option.gen(function* () {
    const markdown = yield* Option.fromUndefinedOr(ConfigMarkdown.parseOption(content))
    const frontmatter = yield* decodeFrontmatter(markdown.data)
    // Only a markdown file at the root of the directory takes its name from the file name.
    const name = yield* Option.fromUndefinedOr(frontmatter.name).pipe(
      Option.orElse(() =>
        path.dirname(filepath) === directory ? Option.some(path.basename(filepath, ".md")) : Option.none(),
      ),
      Option.filter((name) => name.length > 0),
    )
    return {
      name,
      description: frontmatter.description,
      slash: frontmatter.slash,
      location: AbsolutePath.make(filepath),
      content: markdown.content,
    }
  })

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: string) {
      const files = yield* fs
        .scan("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const skills = yield* Effect.forEach(files.toSorted(), (filepath) =>
        fs.readFileStringSafe(filepath).pipe(
          Effect.map((content) =>
            Option.fromUndefinedOr(content).pipe(
              Option.filter((content) => content.length > 0),
              Option.flatMap((content) => parseSkill(directory, filepath, content)),
            ),
          ),
          Effect.catch(() => Effect.succeedNone),
        ),
      )
      return skills.flatMap(Option.toArray)
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      const skills = yield* Effect.forEach(directories, (directory) => loadDirectory(directory))
      return skills.flat()
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = MutableHashMap.empty<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      // MutableHashMap iterates in insertion order, so a later skill with the same name
      // replaces the value but keeps the position of the first one.
      const skills = MutableHashMap.empty<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const cached = MutableHashMap.get(cache, key)
        const loaded = Option.isSome(cached) ? cached.value : yield* load(source)
        MutableHashMap.set(cache, key, loaded)
        for (const skill of loaded) MutableHashMap.set(skills, skill.name, skill)
      }
      return Array.from(MutableHashMap.values(skills))
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
