import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"
import { defineConfig, type PluginOption } from "vite"

export default defineConfig({
  base: "/data/",
  plugins: [
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- (a) @solidjs/start types solidStart() against its nested vite 7.1.10, not the app's vite 7.1.4
    solidStart() as PluginOption,
    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }),
  ],
  server: {
    allowedHosts: true,
  },
  build: {
    minify: "esbuild",
    cssMinify: true,
  },
})
