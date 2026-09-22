import tseslint from "typescript-eslint"
import { effectLintConfig } from "./effect-eslint-config.mjs"

// Start the blocking gate at the protocol and native Effect boundaries.
// Other package configs still load the language service during type checks.
const runtimeFiles = ["packages/protocol/src/**/*.ts", "packages/effect-sqlite-node/src/**/*.ts"]

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/httpapi-codegen/test/generated/**",
      "packages/sdk/js/src/gen/**",
    ],
  },
  {
    files: runtimeFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
  effectLintConfig(runtimeFiles),
  {
    // Event metadata is an intentionally open wire boundary.
    files: ["packages/protocol/src/groups/event.ts"],
    rules: { "effect/no-schema-any-unknown": "off" },
  },
  {
    // This adapter implements optional native driver values and catches native exceptions.
    files: ["packages/effect-sqlite-node/src/index.ts"],
    rules: {
      "effect/no-undefined-use-option": "off",
      "effect/no-try-catch-use-effect": "off",
    },
  },
]
