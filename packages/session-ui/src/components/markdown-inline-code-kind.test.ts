import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { inlineCodeKind } from "./markdown-inline-code-kind"

describe("inlineCodeKind", () => {
  test("leaves code expressions as normal inline code", () => {
    expect(
      inlineCodeKind(
        `case "question.asked": ... input.setStore("question", question.sessionID, [question]) / splice/insert`,
      ),
    ).toEqual(Option.none())
    expect(inlineCodeKind(`<SessionQuestionDock request={request} ... />`)).toEqual(Option.none())
    expect(inlineCodeKind(`from sync.data.question + sync.data.session.`)).toEqual(Option.none())
    expect(inlineCodeKind(`@opencode-ai/app <StatusPopover />)`)).toEqual(Option.none())
    expect(inlineCodeKind(`sync.data.session`)).toEqual(Option.none())
    expect(inlineCodeKind(`window.api`)).toEqual(Option.none())
    expect(inlineCodeKind(`1.2`)).toEqual(Option.none())
  })

  test("detects file and directory paths", () => {
    expect(inlineCodeKind(`app.tsx`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`vite.config.mjs`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`eslint.config.cjs`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`app.d.ts`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`component.svelte`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`schema.graphql`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`Dockerfile`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`Dockerfile.dev`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`.gitignore`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`Cargo.lock`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`go.sum`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`bun.lockb`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`terraform.tfvars`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`pnpm-lock.yaml`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`packages/desktop-electron`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`~/.config/opencode`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`@opencode-ai/app`)).toEqual(Option.some("path"))
    expect(inlineCodeKind(`session/status`)).toEqual(Option.some("path"))
  })

  test("detects urls", () => {
    expect(inlineCodeKind(`https://opencode.ai/docs`)).toEqual(Option.some("url"))
    expect(inlineCodeKind(`http://localhost:4444`)).toEqual(Option.some("url"))
    expect(inlineCodeKind(`file:///tmp/opencode`)).toEqual(Option.none())
    expect(inlineCodeKind(`ftp://opencode.ai/docs`)).toEqual(Option.none())
  })
})
