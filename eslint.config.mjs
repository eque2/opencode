import tseslint from "typescript-eslint"
import { effectLintConfig } from "./effect-eslint-config.mjs"

// The blocking gate covers every package's runtime source.
const runtimeFiles = ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"]

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
        ecmaFeatures: { jsx: true },
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
