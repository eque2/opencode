import { Data, Predicate, Schema } from "effect"

/**
 * Base of the named error family. Data.Error makes every instance a yieldable failure in Effect.gen.
 * The constructor keeps the Error contract (message, options) that subclasses in other packages call.
 */
export abstract class NamedError extends Data.Error {
  constructor(message?: string, options?: ErrorOptions) {
    super()
    // As with Error, message and cause are own non-enumerable properties, so JSON output stays { name, data }.
    // Reflect.defineProperty returns a boolean; Object.defineProperty would return this Effect-able instance.
    Reflect.defineProperty(this, "message", { value: message ?? "", writable: true, configurable: true })
    if (options && "cause" in options) {
      Reflect.defineProperty(this, "cause", { value: options.cause, writable: true, configurable: true })
    }
  }

  abstract schema(): Schema.Top
  abstract toObject(): { name: string; data: unknown }

  static hasName(error: unknown, name: string): boolean {
    return Predicate.isObjectOrArray(error) && "name" in error && error.name === name
  }

  static create<Name extends string, Fields extends Schema.Struct.Fields>(
    name: Name,
    fields: Fields,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, Schema.Struct<Fields>>>
  static create<Name extends string, DataSchema extends Schema.Top>(
    name: Name,
    data: DataSchema,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, DataSchema>>
  static create<Name extends string>(name: Name, data: Schema.Top | Schema.Struct.Fields) {
    return NamedError.createSchemaClass(name, Schema.isSchema(data) ? data : Schema.Struct(data))
  }

  private static createSchemaClass<Name extends string, DataSchema extends Schema.Top>(name: Name, data: DataSchema) {
    const schema = Schema.Struct({
      name: Schema.Literal(name),
      data,
    }).annotate({ identifier: name })
    type Data = Schema.Schema.Type<DataSchema>

    const result = class extends NamedError {
      public static readonly Schema = schema
      public static readonly EffectSchema = schema
      public static readonly tag = name

      public override readonly name = name

      constructor(
        public readonly data: Data,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: unknown): input is InstanceType<typeof result> {
        return NamedError.hasName(input, name)
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create("UnknownError", {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  })
}
