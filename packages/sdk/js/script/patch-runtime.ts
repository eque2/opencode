import path from "path"

/**
 * One exact-text replacement in a runtime file that @hey-api/openapi-ts copies
 * into the generated client.
 */
export interface RuntimePatch {
  /** File path relative to the generated client folder. */
  readonly file: string
  /** The lint rule that the replacement satisfies. */
  readonly rule: string
  /** Text that must occur exactly once in the prettier-formatted file. */
  readonly search: string
  /** Text that replaces `search`. */
  readonly replace: string
}

const lines = (...parts: ReadonlyArray<string>) => parts.join("\n")

/**
 * Typed replacements for constructs in the @hey-api/openapi-ts 0.90.10
 * runtime templates (core/*.gen.ts and client/*.gen.ts) that oxlint flags.
 * The patches match the prettier-formatted output, so build.ts formats the
 * generated folder before it applies them. The helper names and forms match
 * the hand-maintained v1 runtime in src/gen.
 */
export const runtimePatches: ReadonlyArray<RuntimePatch> = [
  // typescript/no-unsafe-type-assertion
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("interface SerializePrimitiveParam extends SerializePrimitiveOptions {", "  value: string", "}", ""),
    replace: lines(
      "interface SerializePrimitiveParam extends SerializePrimitiveOptions {",
      "  value: unknown",
      "}",
      "",
      "/**",
      " * Converts a parameter value to a string. The result matches the implicit",
      " * ToString coercion that `encodeURIComponent()` and template literals apply,",
      " * including the TypeError for a symbol.",
      " */",
      "export const toParamString = (value: unknown): string => {",
      '  if (typeof value === "symbol") {',
      '    throw new TypeError("Cannot convert a Symbol value to a string")',
      "  }",
      "  return String(value)",
      "}",
      "",
    ),
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "value.map((v) => encodeURIComponent(v as string))",
    replace: "value.map((v) => encodeURIComponent(toParamString(v)))",
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "        return allowReserved ? v : encodeURIComponent(v as string)\n",
    replace: "        return allowReserved ? v : encodeURIComponent(toParamString(v))\n",
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("        name,", "        value: v as string,", "      })", "    })"),
    replace: lines("        name,", "        value: v,", "      })", "    })"),
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "  return `${name}=${allowReserved ? value : encodeURIComponent(value)}`\n",
    replace: lines(
      "  const text = toParamString(value)",
      "  return `${name}=${allowReserved ? text : encodeURIComponent(text)}`",
      "",
    ),
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "    let values: string[] = []",
      "    Object.entries(value).forEach(([key, v]) => {",
      "      values = [...values, key, allowReserved ? (v as string) : encodeURIComponent(v as string)]",
    ),
    replace: lines(
      "    let values: unknown[] = []",
      "    Object.entries(value).forEach(([key, v]) => {",
      "      values = [...values, key, allowReserved ? v : encodeURIComponent(toParamString(v))]",
    ),
  },
  {
    file: "core/pathSerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("        name: style === \"deepObject\" ? `${name}[${key}]` : key,", "        value: v as string,"),
    replace: lines("        name: style === \"deepObject\" ? `${name}[${key}]` : key,", "        value: v,"),
  },
  {
    file: "core/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("  serializePrimitiveParam,", '} from "./pathSerializer.gen.js"'),
    replace: lines("  serializePrimitiveParam,", "  toParamString,", '} from "./pathSerializer.gen.js"'),
  },
  {
    file: "core/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "export const PATH_PARAM_RE = /\\{[^{}]+\\}/g\n",
    replace: lines(
      "export const PATH_PARAM_RE = /\\{[^{}]+\\}/g",
      "",
      "/**",
      " * Detects a non-null object, so its properties can be read by string key.",
      " */",
      "export const isRecord = (value: unknown): value is Record<string, unknown> =>",
      '  typeof value === "object" && value !== null',
      "",
    ),
  },
  {
    file: "core/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      '      if (typeof value === "object") {',
      "        url = url.replace(",
      "          match,",
      "          serializeObjectParam({",
      "            explode,",
      "            name,",
      "            style,",
      "            value: value as Record<string, unknown>,",
    ),
    replace: lines(
      "      if (isRecord(value)) {",
      "        url = url.replace(",
      "          match,",
      "          serializeObjectParam({",
      "            explode,",
      "            name,",
      "            style,",
      "            value,",
    ),
  },
  {
    file: "core/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("            name,", "            value: value as string,", "          })}`,"),
    replace: lines("            name,", "            value,", "          })}`,"),
  },
  {
    file: "core/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search:
      '      const replaceValue = encodeURIComponent(style === "label" ? `.${value as string}` : (value as string))\n',
    replace: lines(
      "      const text = toParamString(value)",
      '      const replaceValue = encodeURIComponent(style === "label" ? `.${text}` : text)',
      "",
    ),
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "// This file is auto-generated by @hey-api/openapi-ts",
      "",
      'type Slot = "body" | "headers" | "path" | "query"',
      "",
    ),
    replace: lines(
      "// This file is auto-generated by @hey-api/openapi-ts",
      "",
      'import { isRecord } from "./utils.gen.js"',
      "",
      'type Slot = "body" | "headers" | "path" | "query"',
      "",
      "const isSlot = (value: string): value is Slot =>",
      '  value === "body" || value === "headers" || value === "path" || value === "query"',
      "",
    ),
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "const stripEmptySlots = (params: Params) => {",
      "  for (const [slot, value] of Object.entries(params)) {",
      '    if (value && typeof value === "object" && !Object.keys(value).length) {',
      "      delete params[slot as Slot]",
    ),
    replace: lines(
      "/**",
      " * Returns the object that holds the named fields of a slot. A body that an",
      " * earlier argument replaced with a non-object value cannot hold fields.",
      " */",
      "const slotFields = (params: Params, slot: Slot): Record<string, unknown> => {",
      '  if (slot !== "body") {',
      "    return params[slot]",
      "  }",
      "  if (isRecord(params.body)) {",
      "    return params.body",
      "  }",
      "  throw new TypeError(`Cannot set a body field on a ${typeof params.body} body`)",
      "}",
      "",
      "const stripEmptySlots = (params: Params) => {",
      "  for (const [slot, value] of Object.entries(params)) {",
      '    if (isSlot(slot) && value && typeof value === "object" && !Object.keys(value).length) {',
      "      delete params[slot]",
    ),
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "          ;(params[field.in] as Record<string, unknown>)[name] = arg\n",
    replace: "          slotFields(params, field.in)[name] = arg\n",
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "            ;(params[field.in] as Record<string, unknown>)[name] = value\n",
    replace: "            slotFields(params, field.in)[name] = value\n",
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "            ;(params[slot] as Record<string, unknown>)[key.slice(prefix.length)] = value\n",
    replace: "            slotFields(params, slot)[key.slice(prefix.length)] = value\n",
  },
  {
    file: "core/params.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("              if (allowed) {", "                ;(params[slot as Slot] as Record<string, unknown>)[key] = value"),
    replace: lines("              if (allowed && isSlot(slot)) {", "                slotFields(params, slot)[key] = value"),
  },
  {
    file: "core/queryKeySerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "    return JSON.parse(json) as JsonValue\n",
    replace: lines(
      "    const parsed: unknown = JSON.parse(json)",
      "    return isJsonValue(parsed) ? parsed : undefined",
      "",
    ),
  },
  {
    file: "core/queryKeySerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("  return prototype === Object.prototype || prototype === null", "}", ""),
    replace: lines(
      "  return prototype === Object.prototype || prototype === null",
      "}",
      "",
      "/**",
      " * Checks that a value, and every nested value, is a JsonValue.",
      " */",
      "const isJsonValue = (value: unknown): value is JsonValue => {",
      '  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {',
      "    return true",
      "  }",
      "  if (Array.isArray(value)) {",
      "    return value.every(isJsonValue)",
      "  }",
      "  return isPlainObject(value) && Object.values(value).every(isJsonValue)",
      "}",
      "",
    ),
  },
  {
    file: "core/queryKeySerializer.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "      ;(existing as string[]).push(value)\n",
    replace: "      existing.push(value)\n",
  },
  {
    file: "core/serverSentEvents.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "  const createStream = async function* () {\n",
    replace: lines(
      "  type StreamItem = TData extends Record<string, unknown> ? TData[keyof TData] : TData",
      "",
      '  const createStream = async function* (): ServerSentEventsResult<TData>["stream"] {',
      "",
    ),
  },
  {
    file: "core/serverSentEvents.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "      const headers =",
      "        options.headers instanceof Headers",
      "          ? options.headers",
      "          : new Headers(options.headers as Record<string, string> | undefined)",
    ),
    replace: "      const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers)",
  },
  {
    file: "core/serverSentEvents.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "                yield data as any\n",
    replace: lines(
      "                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- @hey-api/openapi-ts SSE boundary: JSON.parse output becomes the caller's generic TData, and the client has no typed validator",
      "                yield data as StreamItem",
      "",
    ),
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      'import { serializeArrayParam, serializeObjectParam, serializePrimitiveParam } from "../core/pathSerializer.gen.js"',
      'import { getUrl } from "../core/utils.gen.js"',
    ),
    replace: lines(
      "import {",
      "  serializeArrayParam,",
      "  serializeObjectParam,",
      "  serializePrimitiveParam,",
      "  toParamString,",
      '} from "../core/pathSerializer.gen.js"',
      'import { getUrl, isRecord } from "../core/utils.gen.js"',
    ),
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      '        } else if (typeof value === "object") {',
      "          const serializedObject = serializeObjectParam({",
      "            allowReserved: options.allowReserved,",
      "            explode: true,",
      "            name,",
      '            style: "deepObject",',
      "            value: value as Record<string, unknown>,",
    ),
    replace: lines(
      "        } else if (isRecord(value)) {",
      "          const serializedObject = serializeObjectParam({",
      "            allowReserved: options.allowReserved,",
      "            explode: true,",
      "            name,",
      '            style: "deepObject",',
      "            value,",
    ),
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("            name,", "            value: value as string,", "          })"),
    replace: lines("            name,", "            value,", "          })"),
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "    baseUrl: options.baseUrl as string,\n",
    replace: '    baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,\n',
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "          mergedHeaders.append(key, v as string)\n",
    replace: "          mergedHeaders.append(key, toParamString(v))\n",
  },
  {
    file: "client/utils.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: '        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : (value as string))\n',
    replace: '        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : toParamString(value))\n',
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "        if (fn) {",
      "          finalError = (await fn(error, undefined as any, request, opts)) as unknown",
    ),
    replace: lines(
      "        if (fn) {",
      "          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- @hey-api/openapi-ts ErrInterceptor requires a Response, but a fetch that throws has none, so the error interceptors receive undefined",
      "          finalError = (await fn(error, undefined as any, request, opts)) as unknown",
    ),
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "            response: undefined as any,\n",
    replace: "            response: undefined,\n",
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("    const error = jsonError ?? textError", "    let finalError = error"),
    replace: lines("    const error = jsonError ?? textError", "    let finalError: unknown = error"),
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "        finalError = (await fn(error, response, request, opts)) as string\n",
    replace: "        finalError = await fn(error, response, request, opts)\n",
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "    finalError = finalError || ({} as string)\n",
    replace: "    finalError = finalError || {}\n",
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines(
      "      body: opts.body as BodyInit | null | undefined,",
      "      headers: opts.headers as unknown as Record<string, string>,",
    ),
    replace: lines(
      "      // createSseClient sends serializedBody and never reads the raw body.",
      "      body: undefined,",
      "      headers: opts.headers,",
    ),
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: "      serializedBody: getValidRequestBody(opts) as BodyInit | null | undefined,\n",
    replace: lines(
      "      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fetch() RequestInit.body (platform API) requires BodyInit, while the @hey-api/openapi-ts BodySerializer returns any and the raw body is unknown; a guard would change which bodies reach fetch",
      "      serializedBody: getValidRequestBody(opts) as BodyInit | null | undefined,",
      "",
    ),
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unsafe-type-assertion",
    search: lines("  return {", "    buildUrl,"),
    replace: lines(
      "  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- @hey-api/openapi-ts Client declares generic MethodFn and SseFn signatures whose onSseEvent callback expects StreamEvent<TData>; the untyped runtime methods cannot satisfy that variance, so annotation and satisfies both fail",
      "  return {",
      "    buildUrl,",
    ),
  },

  // typescript/no-unnecessary-type-assertion
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unnecessary-type-assertion",
    search: "    const _fetch = opts.fetch!\n",
    replace: "    const _fetch = opts.fetch\n",
  },
  {
    file: "client/client.gen.ts",
    rule: "typescript/no-unnecessary-type-assertion",
    search: "          finalError = (await fn(error, undefined as any, request, opts)) as unknown\n",
    replace: "          finalError = await fn(error, undefined as any, request, opts)\n",
  },
  {
    file: "core/queryKeySerializer.gen.ts",
    rule: "typescript/no-unnecessary-type-assertion",
    search: "  const prototype = Object.getPrototypeOf(value as object)\n",
    replace: "  const prototype = Object.getPrototypeOf(value)\n",
  },
]

/**
 * Applies every runtime patch to the generated client in `genDir`. A patch
 * whose search text does not occur exactly once throws, because a changed
 * @hey-api/openapi-ts template must stop the build instead of silently
 * dropping a fix.
 */
export const patchRuntime = async (genDir: string): Promise<void> => {
  const sources = new Map<string, string>()
  for (const patch of runtimePatches) {
    const file = path.join(genDir, patch.file)
    const source = sources.get(file) ?? (await Bun.file(file).text())
    const count = source.split(patch.search).length - 1
    if (count !== 1) {
      throw new Error(
        `Runtime patch for ${patch.rule} matched ${count} times in ${patch.file}; @hey-api/openapi-ts output may have changed`,
      )
    }
    sources.set(
      file,
      source.replace(patch.search, () => patch.replace),
    )
  }
  for (const [file, source] of sources) {
    await Bun.write(file, source)
  }
}
