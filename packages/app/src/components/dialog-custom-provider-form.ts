import { HashSet, Option } from "effect"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

/** The error message of one field. Option.none() means that the field has no error. */
export type FieldErr = Option.Option<string>

export type ModelErr = {
  id: FieldErr
  name: FieldErr
}

export type HeaderErr = {
  key: FieldErr
  value: FieldErr
}

export type ModelRow = {
  row: string
  id: string
  name: string
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID: FieldErr
    name: FieldErr
    baseURL: FieldErr
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: HashSet.HashSet<string>
}

export function validateCustomProvider(input: ValidateArgs) {
  const error = (key: string): FieldErr => Option.some(input.t(key))
  const valid: FieldErr = Option.none()

  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? Option.some(apiKey) : Option.none<string>()

  const idError = !providerID
    ? error("provider.custom.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? error("provider.custom.error.providerID.format")
      : valid

  const nameError = !name ? error("provider.custom.error.name.required") : valid
  const urlError = !baseURL
    ? error("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? error("provider.custom.error.baseURL.format")
      : valid

  const disabled = input.disabledProviders.includes(providerID)
  const existsError = Option.isSome(idError)
    ? valid
    : HashSet.has(input.existingProviderIDs, providerID) && !disabled
      ? error("provider.custom.error.providerID.exists")
      : valid

  const models = input.form.models.map((m, index): ModelErr => {
    const id = m.id.trim()
    // A row repeats an ID when an earlier row has the same trimmed ID.
    const idError = !id
      ? error("provider.custom.error.required")
      : input.form.models.findIndex((other) => other.id.trim() === id) < index
        ? error("provider.custom.error.duplicate")
        : valid
    const nameError = !m.name.trim() ? error("provider.custom.error.required") : valid
    return { id: idError, name: nameError }
  })
  const modelConfig = Object.fromEntries(input.form.models.map((m) => [m.id.trim(), { name: m.name.trim() }]))

  const headers = input.form.headers.map((h, index): Partial<HeaderErr> => {
    const key = h.key.trim()
    const value = h.value.trim()

    // A blank row sets no error, so the store keeps the errors that the row shows.
    if (!key && !value) return {}
    // Header names are case-insensitive, so a row repeats a name when an earlier row has it in any case.
    const keyError = !key
      ? error("provider.custom.error.required")
      : input.form.headers.findIndex((other) => other.key.trim().toLowerCase() === key.toLowerCase()) < index
        ? error("provider.custom.error.duplicate")
        : valid
    const valueError = !value ? error("provider.custom.error.required") : valid
    return { key: keyError, value: valueError }
  })
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err: FormState["err"] = {
    providerID: Option.orElse(idError, () => existsError),
    name: nameError,
    baseURL: urlError,
  }

  const ok = !hasError(err) && !models.some(hasError) && !headers.some(hasError)
  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  }
}

/** True when a record holds at least one field error. A key that is left out holds no error. */
const hasError = (err: Partial<Record<string, FieldErr>>) =>
  Object.values(err).some((value) => value !== undefined && Option.isSome(value))

/** The TextField props for a field error: the invalid state and the message, or no props for a valid field. */
export const textFieldError = (err: FieldErr) =>
  Option.match(err, {
    onNone: () => ({}),
    onSome: (error) => ({ validationState: "invalid" as const, error }),
  })

/** The form errors with no field in error. */
export const formErr = (): FormState["err"] => ({
  providerID: Option.none(),
  name: Option.none(),
  baseURL: Option.none(),
})

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({
  row: nextRow(),
  id: "",
  name: "",
  err: { id: Option.none(), name: Option.none() },
})
export const headerRow = (): HeaderRow => ({
  row: nextRow(),
  key: "",
  value: "",
  err: { key: Option.none(), value: Option.none() },
})
