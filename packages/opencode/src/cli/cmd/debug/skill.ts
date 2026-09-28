import { EOL } from "os"
import { Effect, Schema } from "effect"
import { Skill } from "../../../skill"
import { effectCmd } from "../../effect-cmd"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const SkillCommand = effectCmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.skill")(function* () {
    const skill = yield* Skill.Service
    const skills = yield* skill.all()
    process.stdout.write((yield* encodeJson(skills).pipe(Effect.orDie)) + EOL)
  }),
})
