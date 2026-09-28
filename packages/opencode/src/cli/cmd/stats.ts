import { Console, DateTime, Effect, Option } from "effect"
import { effectCmd } from "../effect-cmd"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"

interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(ctx.project, args.days, args.project)
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }
    yield* displayStats(stats, args.tools, modelLimit)
  }),
})

const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row))
})

const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  currentProject: Project.Info,
  days?: number,
  projectFilter?: string,
) {
  const svc = yield* Session.Service
  const sessions = yield* getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000
  const now = yield* DateTime.now
  const nowMillis = DateTime.toEpochMillis(now)

  // `--days 0` means "today": from local midnight, not from 24 hours ago.
  const cutoffTime =
    days === undefined
      ? 0
      : days === 0
        ? DateTime.toEpochMillis(DateTime.startOf(DateTime.setZone(now, DateTime.zoneMakeLocal()), "day"))
        : nowMillis - days * MS_IN_DAY

  const windowDays = days === undefined ? Option.none<number>() : Option.some(days === 0 ? 1 : days)

  const recentSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions
  // An empty `--project` selects the current project.
  const projectID = projectFilter === "" ? currentProject.id : projectFilter
  const filteredSessions =
    projectID === undefined ? recentSessions : recentSessions.filter((session) => session.projectID === projectID)

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: nowMillis,
      latest: nowMillis,
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    yield* Console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = Option.getOrElse(windowDays, () => 0)
    return stats
  }

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const messages = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([])))

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        for (const message of messages) {
          if (message.info.role === "assistant") {
            const modelKey = `${message.info.providerID}/${message.info.modelID}`
            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += message.info.cost || 0

            if (message.info.tokens) {
              sessionModelUsage[modelKey].tokens.input += message.info.tokens.input || 0
              sessionModelUsage[modelKey].tokens.output +=
                (message.info.tokens.output || 0) + (message.info.tokens.reasoning || 0)
              sessionModelUsage[modelKey].tokens.cache.read += message.info.tokens.cache?.read || 0
              sessionModelUsage[modelKey].tokens.cache.write += message.info.tokens.cache?.write || 0
            }
          }

          for (const part of message.parts) {
            if (part.type === "tool" && part.tool) {
              sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
            }
          }
        }

        return {
          messageCount: messages.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  const earliestTime = results.reduce((min, result) => Math.min(min, result.earliestTime), nowMillis)
  const latestTime = results.reduce((max, result) => Math.max(max, result.latestTime), 0)
  const sessionTotalTokens = results.map((result) => result.sessionTotalTokens).sort((a, b) => a - b)

  for (const result of results) {
    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = Option.getOrElse(windowDays, () => rangeDays)
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

// Prints the report to stdout, as the former console.log calls did. Each entry of `lines` is one output line.
export const displayStats = (stats: SessionStats, toolLimit?: number, modelLimit?: number) =>
  Console.log(statsLines(stats, toolLimit, modelLimit).join("\n"))

function statsLines(stats: SessionStats, toolLimit?: number, modelLimit?: number): string[] {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession

  const overview = [
    "┌────────────────────────────────────────────────────────┐",
    "│                       OVERVIEW                         │",
    "├────────────────────────────────────────────────────────┤",
    renderRow("Sessions", stats.totalSessions.toLocaleString()),
    renderRow("Messages", stats.totalMessages.toLocaleString()),
    renderRow("Days", stats.days.toString()),
    "└────────────────────────────────────────────────────────┘",
    "",
  ]

  const costAndTokens = [
    "┌────────────────────────────────────────────────────────┐",
    "│                    COST & TOKENS                       │",
    "├────────────────────────────────────────────────────────┤",
    renderRow("Total Cost", `$${cost.toFixed(2)}`),
    renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`),
    renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))),
    renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))),
    renderRow("Input", formatNumber(stats.totalTokens.input)),
    renderRow("Output", formatNumber(stats.totalTokens.output)),
    renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)),
    renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)),
    "└────────────────────────────────────────────────────────┘",
    "",
  ]

  const modelUsage = (() => {
    if (modelLimit === undefined || Object.keys(stats.modelUsage).length === 0) return []
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)
    return [
      "┌────────────────────────────────────────────────────────┐",
      "│                      MODEL USAGE                       │",
      "├────────────────────────────────────────────────────────┤",
      ...modelsToDisplay.flatMap(([model, usage]) => [
        `│ ${model.padEnd(54)} │`,
        renderRow("  Messages", usage.messages.toLocaleString()),
        renderRow("  Input Tokens", formatNumber(usage.tokens.input)),
        renderRow("  Output Tokens", formatNumber(usage.tokens.output)),
        renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)),
        renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)),
        renderRow("  Cost", `$${usage.cost.toFixed(4)}`),
        "├────────────────────────────────────────────────────────┤",
      ]),
      // The escape moves the cursor up one line, so the bottom border replaces the last separator.
      "\x1B[1A└────────────────────────────────────────────────────────┘",
    ]
  })()

  const toolUsage = (() => {
    if (Object.keys(stats.toolUsage).length === 0) return []
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools
    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)
    const maxToolLength = 18
    return [
      "┌────────────────────────────────────────────────────────┐",
      "│                      TOOL USAGE                        │",
      "├────────────────────────────────────────────────────────┤",
      ...toolsToDisplay.map(([tool, count]) => {
        const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
        const bar = "█".repeat(barLength)
        const percentage = ((count / totalToolUsage) * 100).toFixed(1)
        const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
        const toolName = truncatedTool.padEnd(maxToolLength)
        const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
        const padding = Math.max(0, width - content.length - 1)
        return `│${content}${" ".repeat(padding)} │`
      }),
      "└────────────────────────────────────────────────────────┘",
    ]
  })()

  return [...overview, ...costAndTokens, ...modelUsage, "", ...toolUsage, ""]
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
