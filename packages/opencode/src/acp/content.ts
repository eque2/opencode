import type { ContentBlock, ContentChunk, ResourceLink, Role } from "@agentclientprotocol/sdk"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Option } from "effect"

export type PromptPart = SessionV1.TextPartInput | SessionV1.FilePartInput

export type ReplayPart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "file"
      url: string
      mime: string
      filename?: string
    }
  | {
      type: "reasoning"
      text: string
    }

export function promptContentToParts(content: readonly ContentBlock[]): PromptPart[] {
  return content.flatMap(contentBlockToParts)
}

export function contentBlockToParts(block: ContentBlock): PromptPart[] {
  switch (block.type) {
    case "text":
      return [
        {
          type: "text",
          text: block.text,
          ...audienceFlags(block.annotations?.audience),
        },
      ]

    case "image":
      if (block.data) {
        return [
          {
            type: "file",
            url: `data:${block.mimeType};base64,${block.data}`,
            filename: filenameOr(block.uri, "image"),
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("data:")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameOr(block.uri, "image"),
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("http://") || block.uri?.startsWith("https://")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameOr(block.uri, "image"),
            mime: block.mimeType,
          },
        ]
      }
      return []

    case "resource_link":
      return [resourceLinkToPart(block)]

    case "resource":
      if ("text" in block.resource) {
        const uri = block.resource.uri
        const label = Option.getOrElse(fileResourceLabel(uri), () => uri)
        return [{ type: "text", text: `[${label}]\n${block.resource.text}` }]
      }
      if (block.resource.mimeType) {
        return [
          {
            type: "file",
            url: block.resource.uri.startsWith("data:")
              ? block.resource.uri
              : `data:${block.resource.mimeType};base64,${block.resource.blob}`,
            filename: filenameOr(block.resource.uri, "file"),
            mime: block.resource.mimeType,
          },
        ]
      }
      return []

    default:
      return []
  }
}

export function partsToContentChunks(parts: readonly ReplayPart[]): ContentChunk[] {
  return parts.flatMap(partToContentChunks)
}

export function partToContentChunks(part: ReplayPart): ContentChunk[] {
  if (part.type === "file") return filePartToContentChunks(part)
  if (!part.text) return []
  return [
    {
      content: {
        type: "text",
        text: part.text,
        ...(part.type === "text" ? partAudience(part) : {}),
      },
    },
  ]
}

function resourceLinkToPart(link: ResourceLink): PromptPart {
  const parsed = uriToFilePart(link.uri, link.mimeType ?? "text/plain", link.name)
  if (parsed.type === "file") return parsed
  return { type: "text", text: parsed.text }
}

function uriToFilePart(
  uri: string,
  mime: string,
  filename?: string,
): SessionV1.FilePartInput | SessionV1.TextPartInput {
  const text: SessionV1.TextPartInput = { type: "text", text: uri }
  if (uri.startsWith("file://")) {
    return {
      type: "file",
      url: uri,
      filename: filename ?? filenameOr(uri, "file"),
      mime,
    }
  }
  if (!uri.startsWith("zed://")) return text
  return parseUrl(uri).pipe(
    Option.flatMap((parsed) => Option.fromNullishOr(parsed.searchParams.get("path"))),
    Option.filter((pathname) => pathname.length > 0),
    Option.flatMap((pathname) =>
      fileUrlHref(pathname).pipe(
        Option.map(
          (url): SessionV1.FilePartInput => ({
            type: "file",
            url,
            filename: filename ?? (path.basename(pathname) || "file"),
            mime,
          }),
        ),
      ),
    ),
    Option.getOrElse(() => text),
  )
}

function filePartToContentChunks(part: Extract<ReplayPart, { type: "file" }>): ContentChunk[] {
  if (part.url.startsWith("file://")) {
    return [
      {
        content: {
          type: "resource_link",
          uri: part.url,
          name: part.filename ?? "file",
          mimeType: part.mime,
        },
      },
    ]
  }
  if (!part.url.startsWith("data:")) return []

  const decoded = decodeDataUrl(part.url)
  if (Option.isNone(decoded)) return []
  const data = decoded.value
  if (data.mime.startsWith("image/")) {
    return [
      {
        content: {
          type: "image",
          mimeType: data.mime,
          data: data.base64,
          uri: pathToFileURL(part.filename ?? "image").href,
        },
      },
    ]
  }

  return [
    {
      content: {
        type: "resource",
        resource:
          data.mime.startsWith("text/") || data.mime === "application/json"
            ? {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                text: Buffer.from(data.base64, "base64").toString("utf8"),
              }
            : {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                blob: data.base64,
              },
      },
    },
  ]
}

function decodeDataUrl(url: string): Option.Option<{ readonly mime: string; readonly base64: string }> {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (!match) return Option.none()
  return Option.some({ mime: match[1], base64: match[2] })
}

function audienceFlags(audience: readonly Role[] | null | undefined) {
  if (audience?.length === 1 && audience[0] === "assistant") return { synthetic: true }
  if (audience?.length === 1 && audience[0] === "user") return { ignored: true }
  return {}
}

function partAudience(part: Extract<ReplayPart, { type: "text" }>) {
  if (part.synthetic) return annotateAudience(["assistant"])
  if (part.ignored) return annotateAudience(["user"])
  return {}
}

function annotateAudience(audience: Role[]) {
  return { annotations: { audience } }
}

const parseUrl = Option.liftThrowable((uri: string) => new URL(uri))
const filePathFromUrl = Option.liftThrowable((url: URL) => fileURLToPath(url))
const decodeUriComponent = Option.liftThrowable((value: string) => decodeURIComponent(value))
const fileUrlHref = Option.liftThrowable((pathname: string) => pathToFileURL(pathname).href)

function fileResourceLabel(uri: string): Option.Option<string> {
  return parseUrl(uri).pipe(
    Option.filter((parsed) => parsed.protocol === "file:"),
    Option.flatMap((parsed) =>
      Option.orElse(filePathFromUrl(parsed), () => decodeUriComponent(parsed.pathname)).pipe(
        Option.map((filepath) => {
          const line = parsed.hash.match(/^#L(\d+)/)?.[1]
          const normalized = path.sep === "\\" ? filepath.replace(/\\/g, "/") : filepath
          return `${normalized}${line ? `:${line}` : ""}`
        }),
      ),
    ),
  )
}

function filenameOr(uri: string | null | undefined, fallback: string) {
  return Option.getOrElse(filenameFromUri(uri), () => fallback)
}

function filenameFromUri(uri: string | null | undefined): Option.Option<string> {
  if (!uri || uri.startsWith("data:")) return Option.none()
  const name = Option.match(parseUrl(uri), {
    onSome: (parsed) => path.basename(parsed.pathname),
    onNone: () => path.basename(uri),
  })
  return name ? Option.some(name) : Option.none()
}
