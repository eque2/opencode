import config from "../../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
process.env.PLAYWRIGHT_SERVER_PORT = String(port)
process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
// The base config declares one web server object. Narrow out the array form before its fields are merged.
const baseWebServer = Array.isArray(config.webServer) ? undefined : config.webServer

export default {
  ...config,
  testDir: ".",
  testIgnore: "unit/**",
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  webServer: {
    ...baseWebServer,
    command: `bun run build && bun run serve -- --host 0.0.0.0 --port ${port} --strictPort`,
    reuseExistingServer: false,
  },
}
