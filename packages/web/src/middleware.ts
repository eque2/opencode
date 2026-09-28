import type { APIContext } from "astro"
import { defineMiddleware } from "astro:middleware"
import { Array, Option } from "effect"
import { exactLocale, matchLocale } from "./i18n/locales"

function docsAlias(pathname: string) {
  return Option.fromNullOr(/^\/docs\/([^/]+)(\/.*)?$/.exec(pathname)).pipe(
    Option.flatMap((hit) => {
      const tail = hit[2] ?? ""
      return exactLocale(hit[1] ?? "").pipe(
        Option.map((locale) => ({
          path: locale === "root" ? `/docs${tail}` : `/docs/${locale}${tail}`,
          locale,
        })),
      )
    }),
    Option.filter((alias) => alias.path !== pathname),
  )
}

function redirect(ctx: APIContext, path: string) {
  const next = new URL(ctx.url.toString())
  next.pathname = path
  // Astro builds the 302 with an empty body and merges ctx.cookies into it as Set-Cookie headers.
  return ctx.redirect(next.toString(), 302)
}

function setLocaleCookie(ctx: APIContext, locale: string) {
  ctx.cookies.set("oc_locale", locale === "root" ? "en" : locale, {
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
  })
}

function localeFromCookie(header: string | null) {
  return Option.fromNullOr(header).pipe(
    Option.flatMap((value) =>
      Array.findFirst(
        value.split(";").map((x) => x.trim()),
        (x) => x.startsWith("oc_locale="),
      ),
    ),
    Option.map((x) => x.slice("oc_locale=".length)),
    Option.filter((raw) => raw.length > 0),
    Option.flatMap(matchLocale),
  )
}

function localeFromAcceptLanguage(header: string | null) {
  if (!header) return "root"

  const items = header
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split(";").map((x) => x.trim())
      const lang = parts[0] ?? ""
      const q = parts
        .slice(1)
        .find((x) => x.startsWith("q="))
        ?.slice(2)
      return {
        lang,
        q: q ? Number.parseFloat(q) : 1,
      }
    })
    .sort((a, b) => b.q - a.q)

  return Array.findFirst(
    items.map((item) => item.lang).filter((lang) => lang && lang !== "*"),
    matchLocale,
  ).pipe(Option.getOrElse(() => "root"))
}

export const onRequest = defineMiddleware((ctx, next) => {
  const alias = docsAlias(ctx.url.pathname)
  if (Option.isSome(alias)) {
    setLocaleCookie(ctx, alias.value.locale)
    return redirect(ctx, alias.value.path)
  }

  if (ctx.url.pathname !== "/docs" && ctx.url.pathname !== "/docs/") return next()

  const locale = localeFromCookie(ctx.request.headers.get("cookie")).pipe(
    Option.getOrElse(() => localeFromAcceptLanguage(ctx.request.headers.get("accept-language"))),
  )
  if (locale === "root") return next()

  return redirect(ctx, `/docs/${locale}/`)
})
