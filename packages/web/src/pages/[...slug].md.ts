import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import { Effect, Predicate } from "effect"

function notFoundText(locals: unknown) {
  if (!Predicate.hasProperty(locals, "t")) {
    return "share.not_found"
  }
  const t = locals.t
  if (typeof t !== "function") {
    return "share.not_found"
  }
  const text = t("share.not_found")
  if (typeof text === "string" && text.length > 0) {
    return text
  }
  return "share.not_found"
}

// Astro calls GET and awaits the Promise, so the route runs its Effect at this boundary.
export const GET: APIRoute = ({ params, locals }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const slug = params.slug || "index"
      const docs = yield* Effect.promise(() => getCollection("docs"))
      const doc = docs.find((d) => d.id === slug)
      const notFound = notFoundText(locals)

      if (!doc) {
        return new Response(notFound, { status: 404, statusText: notFound })
      }

      return new Response(doc.body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      })
    }),
  )
