import { createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { dict, type Key } from "../i18n"
import { useLanguage } from "./language"

function resolve(text: string, params?: Record<string, string | number>) {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (raw, key) => {
    const value = params[key]
    if (value === undefined || value === null) return raw
    return String(value)
  })
}

const ctx = createSimpleContext({
  name: "StatsI18n",
  init: () => {
    const language = useLanguage()
    const dictionary = createMemo(() => dict(language.locale()))

    return {
      t(key: Key, params?: Record<string, string | number>) {
        return resolve(dictionary()[key], params)
      },
    }
  },
})

export const useI18n = () => ctx.use()
export const I18nProvider = ctx.provider
