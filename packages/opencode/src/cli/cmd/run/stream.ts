// Thin bridge between reducer output and the footer API.
//
// The reducers produce StreamCommit[] and an optional FooterOutput (patch +
// view + subagent state). This module forwards them to footer.append() and
// footer.event() respectively, adding trace writes along the way. It also
// defaults status updates to phase "running" if the caller didn't set a
// phase -- a convenience so reducer code doesn't have to repeat that.
import type { FooterApi, FooterOutput, FooterPatch, FooterSubagentState, StreamCommit } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type OutputInput = {
  footer: FooterApi
  trace?: Trace
}

type StreamOutput = {
  commits: StreamCommit[]
  footer?: FooterOutput
}

// Default to "running" phase when a status string arrives without an explicit phase.
function patch(next: FooterPatch): FooterPatch {
  if (typeof next.status === "string" && next.phase === undefined) {
    return {
      phase: "running",
      ...next,
    }
  }

  return next
}

function summarize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 160) {
      return value
    }

    return {
      type: "string",
      length: value.length,
      preview: `${value.slice(0, 160)}...`,
    }
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
    }
  }

  if (!value || typeof value !== "object") {
    return value
  }

  return {
    type: "object",
    keys: Object.keys(value),
  }
}

// The trace is JSON text, so an absent key and an undefined key write the same line.
function traceCommit(commit: StreamCommit) {
  const { part, ...rest } = commit
  return {
    ...rest,
    text: summarize(commit.text),
    textLength: commit.text.length,
    ...(part
      ? {
          part: {
            id: part.id,
            sessionID: part.sessionID,
            messageID: part.messageID,
            callID: part.callID,
            tool: part.tool,
            state: {
              status: part.state.status,
              ...("title" in part.state ? { title: summarize(part.state.title) } : {}),
              ...("error" in part.state ? { error: summarize(part.state.error) } : {}),
              ...("time" in part.state ? { time: summarize(part.state.time) } : {}),
              input: summarize(part.state.input),
              ...("metadata" in part.state ? { metadata: summarize(part.state.metadata) } : {}),
            },
          },
        }
      : {}),
  }
}

export function traceSubagentState(state: FooterSubagentState) {
  return {
    tabs: state.tabs,
    details: Object.fromEntries(
      Object.entries(state.details).map(([sessionID, detail]) => [
        sessionID,
        {
          sessionID,
          commits: detail.commits.map(traceCommit),
        },
      ]),
    ),
    permissions: state.permissions.map((item) => ({
      id: item.id,
      sessionID: item.sessionID,
      permission: item.permission,
      patterns: item.patterns,
      tool: item.tool,
      ...(item.metadata
        ? {
            metadata: {
              keys: Object.keys(item.metadata),
              input: summarize(item.metadata.input),
            },
          }
        : {}),
    })),
    questions: state.questions.map((item) => ({
      id: item.id,
      sessionID: item.sessionID,
      questions: item.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options.length,
        multiple: question.multiple,
      })),
    })),
  }
}

export function traceFooterOutput(footer?: FooterOutput) {
  if (!footer?.subagent) {
    return footer
  }

  return {
    ...footer,
    subagent: traceSubagentState(footer.subagent),
  }
}

// Forwards reducer output to the footer: commits go to scrollback, patches update the status bar.
export function writeSessionOutput(input: OutputInput, out: StreamOutput): void {
  for (const commit of out.commits) {
    input.trace?.write("ui.commit", commit)
    input.footer.append(commit)
  }

  if (out.footer?.patch) {
    const next = patch(out.footer.patch)
    input.trace?.write("ui.patch", next)
    input.footer.event({
      type: "stream.patch",
      patch: next,
    })
  }

  if (out.footer?.subagent) {
    input.trace?.write("ui.subagent", traceSubagentState(out.footer.subagent))
    input.footer.event({
      type: "stream.subagent",
      state: out.footer.subagent,
    })
  }

  if (!out.footer?.view) {
    return
  }

  input.trace?.write("ui.patch", {
    view: out.footer.view,
  })
  input.footer.event({
    type: "stream.view",
    view: out.footer.view,
  })
}
