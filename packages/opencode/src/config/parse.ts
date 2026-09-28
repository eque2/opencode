export * as ConfigParse from "./parse"

import { type ParseError as JsoncParseError, parse as parseJsoncImpl, printParseErrorCode } from "jsonc-parser"
import { Cause, Exit, Schema as EffectSchema, SchemaIssue } from "effect"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { InvalidError, JsonError } from "@opencode-ai/core/v1/config/error"

/** Parses JSONC text. The Exit is an Effect, so Effect code can `yield*` it. */
export function parseJsonc(text: string, filepath: string): Exit.Exit<unknown, InstanceType<typeof JsonError>> {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(text, errors, { allowTrailingComma: true })
  if (!errors.length) return Exit.succeed(data)

  const lines = text.split("\n")
  const issues = errors
    .map((e) => {
      const beforeOffset = text.substring(0, e.offset).split("\n")
      const line = beforeOffset.length
      const column = beforeOffset[beforeOffset.length - 1].length + 1
      const problemLine = lines[line - 1]

      const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
      if (!problemLine) return error

      return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
    })
    .join("\n")
  return Exit.fail(
    new JsonError({
      path: filepath,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${issues}\n--- End ---`,
    }),
  )
}

/** Decodes config data with a schema. The Exit is an Effect, so Effect code can `yield*` it. */
export function decodeSchema<S extends EffectSchema.Decoder<unknown>>(
  schema: S,
  data: unknown,
  source: string,
): Exit.Exit<DeepMutable<S["Type"]>, InstanceType<typeof InvalidError>> {
  const decoded = EffectSchema.decodeUnknownExit(schema)(data, {
    errors: "all",
    onExcessProperty: "ignore",
  })
  if (Exit.isSuccess(decoded)) return Exit.succeed(decoded.value as DeepMutable<S["Type"]>)
  const error = Cause.squash(decoded.cause)

  return Exit.fail(
    new InvalidError(
      {
        path: source,
        issues: EffectSchema.isSchemaError(error)
          ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
              ...issue,
              message: issue.message,
              path: issue.path?.map(String) ?? [],
            }))
          : [{ message: String(error), path: [] }],
      },
      { cause: error },
    ),
  )
}
