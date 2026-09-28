import { createProviderToolFactoryWithOutputSchema } from "@ai-sdk/provider-utils"
import { Schema } from "effect"

// Unknown image generation options are an error: decode these args with onExcessProperty "error".
export const imageGenerationArgsSchema = Schema.Struct({
  background: Schema.optional(Schema.Literals(["auto", "opaque", "transparent"])),
  inputFidelity: Schema.optional(Schema.Literals(["low", "high"])),
  inputImageMask: Schema.optional(
    Schema.Struct({
      fileId: Schema.optional(Schema.String),
      imageUrl: Schema.optional(Schema.String),
    }),
  ),
  model: Schema.optional(Schema.String),
  moderation: Schema.optional(Schema.Literals(["auto"])),
  outputCompression: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  outputFormat: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
  partialImages: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  size: Schema.optional(Schema.Literals(["1024x1024", "1024x1536", "1536x1024", "auto"])),
}).annotate({ identifier: "CopilotResponses.ImageGenerationArgs" })

export const imageGenerationOutputSchema = Schema.Struct({
  result: Schema.String,
}).annotate({ identifier: "CopilotResponses.ImageGenerationOutput" })

type ImageGenerationArgs = {
  /**
   * Background type for the generated image. Default is 'auto'.
   */
  background?: "auto" | "opaque" | "transparent"

  /**
   * Input fidelity for the generated image. Default is 'low'.
   */
  inputFidelity?: "low" | "high"

  /**
   * Optional mask for inpainting.
   * Contains image_url (string, optional) and file_id (string, optional).
   */
  inputImageMask?: {
    /**
     * File ID for the mask image.
     */
    fileId?: string

    /**
     * Base64-encoded mask image.
     */
    imageUrl?: string
  }

  /**
   * The image generation model to use. Default: gpt-image-1.
   */
  model?: string

  /**
   * Moderation level for the generated image. Default: auto.
   */
  moderation?: "auto"

  /**
   * Compression level for the output image. Default: 100.
   */
  outputCompression?: number

  /**
   * The output format of the generated image. One of png, webp, or jpeg.
   * Default: png
   */
  outputFormat?: "png" | "jpeg" | "webp"

  /**
   * Number of partial images to generate in streaming mode, from 0 (default value) to 3.
   */
  partialImages?: number

  /**
   * The quality of the generated image.
   * One of low, medium, high, or auto. Default: auto.
   */
  quality?: "auto" | "low" | "medium" | "high"

  /**
   * The size of the generated image.
   * One of 1024x1024, 1024x1536, 1536x1024, or auto.
   * Default: auto.
   */
  size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024"
}

const imageGenerationToolFactory = createProviderToolFactoryWithOutputSchema<
  {},
  {
    /**
     * The generated image encoded in base64.
     */
    result: string
  },
  ImageGenerationArgs
>({
  id: "openai.image_generation",
  inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
  outputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(imageGenerationOutputSchema)),
})

export const imageGeneration = (
  args: ImageGenerationArgs = {}, // default
) => {
  return imageGenerationToolFactory(args)
}
