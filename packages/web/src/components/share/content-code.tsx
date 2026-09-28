import { Effect } from "effect"
import { codeToHtml, bundledLanguages } from "shiki"
import { createResource, Suspense } from "solid-js"
import style from "./content-code.module.css"

interface Props {
  code: string
  lang?: string
  flush?: boolean
}
export function ContentCode(props: Props) {
  const [html] = createResource(
    () => [props.code, props.lang],
    // createResource takes a Promise-returning fetcher, so the Effect runs at this boundary.
    // TODO: For testing delays
    // await new Promise((resolve) => setTimeout(resolve, 3000))
    ([code, lang]) =>
      Effect.runPromise(
        Effect.promise(() =>
          codeToHtml(code || "", {
            lang: lang && lang in bundledLanguages ? lang : "text",
            themes: {
              light: "github-light",
              dark: "github-dark",
            },
          }),
        ),
      ),
  )
  return (
    <Suspense>
      <div innerHTML={html()} class={style.root} {...(props.flush === true ? { "data-flush": true } : {})} />
    </Suspense>
  )
}
