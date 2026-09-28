import * as path from "path"
import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

/** A patch the tool rejects: its message tells the model how to correct the patch. */
export class ApplyPatchError extends Schema.TaggedError<ApplyPatchError>()("ApplyPatchTool.ApplyPatchError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type FileChange = {
  filePath: string
  oldContent: string
  newContent: string
  type: "add" | "update" | "delete" | "move"
  movePath: Option.Option<string>
  diff: string
  additions: number
  deletions: number
  bom: boolean
}

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* new ApplyPatchError({ message: "patchText is required" })
      }

      // Parse the patch to get hunks
      const hunks = yield* Effect.try({
        try: () => Patch.parsePatch(params.patchText).hunks,
        catch: (error) =>
          new ApplyPatchError({ message: `apply_patch verification failed: ${String(error)}`, cause: error }),
      })

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* new ApplyPatchError({ message: "patch rejected: empty patch" })
        }
        return yield* new ApplyPatchError({ message: "apply_patch verification failed: no hunks found" })
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges = yield* Effect.forEach(hunks, (hunk) =>
        Effect.gen(function* () {
          const filePath = path.resolve(instance.directory, hunk.path)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          if (hunk.type === "add") {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            return {
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              movePath: Option.none(),
              diff,
              additions,
              deletions,
              bom: next.bom,
            } satisfies FileChange
          }

          if (hunk.type === "update") {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.option)
            if (Option.isNone(stats) || stats.value.type === "Directory") {
              return yield* new ApplyPatchError({
                message: `apply_patch verification failed: Failed to read file to update: ${filePath}`,
              })
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text

            // Apply the update chunks to get new content
            const fileUpdate = yield* Effect.try({
              try: () => Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, Bom.join(source.text, source.bom)),
              catch: (error) =>
                new ApplyPatchError({ message: `apply_patch verification failed: ${String(error)}`, cause: error }),
            })
            const newContent = fileUpdate.content
            const bom = fileUpdate.bom

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path
              ? Option.some(path.resolve(instance.directory, hunk.move_path))
              : Option.none<string>()
            if (Option.isSome(movePath)) yield* assertExternalDirectoryEffect(ctx, movePath.value)

            return {
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
            } satisfies FileChange
          }

          const source = yield* Bom.readFile(afs, filePath).pipe(
            Effect.mapError(
              (error) =>
                new ApplyPatchError({ message: `apply_patch verification failed: ${error.message}`, cause: error }),
            ),
          )
          const contentToDelete = source.text
          const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

          const deletions = contentToDelete.split("\n").length

          return {
            filePath,
            oldContent: contentToDelete,
            newContent: "",
            type: "delete",
            movePath: Option.none(),
            diff: deleteDiff,
            additions: 0,
            deletions,
            bom: source.bom,
          } satisfies FileChange
        }),
      )

      const totalDiff = fileChanges.map((change) => change.diff + "\n").join("")

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path
          .relative(instance.worktree, Option.getOrElse(change.movePath, () => change.filePath))
          .replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        ...(Option.isSome(change.movePath) ? { movePath: change.movePath.value } : {}),
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      for (const change of fileChanges) {
        switch (change.type) {
          case "add":
          case "update":
            // Create parent directories (recursive: true is safe on existing/root dirs)
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            break

          case "move":
            if (Option.isSome(change.movePath)) {
              // Create parent directories (recursive: true is safe on existing/root dirs)
              yield* afs.writeWithDirs(change.movePath.value, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            break
        }

        if (change.type !== "delete") {
          const edited = Option.getOrElse(change.movePath, () => change.filePath)
          if (yield* format.file(edited)) {
            yield* Bom.syncFile(afs, edited, change.bom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: edited })
        }
      }

      // Publish file change events, in change order, after every change is applied
      const updates = fileChanges.flatMap((change): Array<{ file: string; event: "add" | "change" | "unlink" }> => {
        if (change.type === "add") return [{ file: change.filePath, event: "add" }]
        if (change.type === "update") return [{ file: change.filePath, event: "change" }]
        if (change.type === "delete") return [{ file: change.filePath, event: "unlink" }]
        return Option.match(change.movePath, {
          onNone: () => [],
          onSome: (movePath) => [
            { file: change.filePath, event: "unlink" },
            { file: movePath, event: "add" },
          ],
        })
      })
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = Option.getOrElse(change.movePath, () => change.filePath)
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = Option.getOrElse(change.movePath, () => change.filePath)
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = Option.getOrElse(change.movePath, () => change.filePath)
        const block = LSP.Diagnostic.report(target, diagnostics[yield* afs.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.provideService(FSUtil.Service, afs), Effect.orDie),
    }
  }),
)
