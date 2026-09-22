import { Schema } from "effect"
import { HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export const NoContentPayload = Schema.Undefined.pipe(Schema.decodeTo(HttpApiSchema.NoContent))

export function described<S extends Schema.Top>(schema: S, description: string): S {
  return schema.annotate({ description }) as S
}

export function responseDescription(description: string) {
  return OpenApi.annotations({
    transform: (operation) => {
      const response = operation.responses?.["200"]
      if (response && typeof response === "object" && "description" in response) {
        response.description = description
      }
      return operation
    },
  })
}
