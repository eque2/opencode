import { Schema } from "effect"
import type {
  ColorValue,
  CssVarRef,
  DesktopTheme,
  HexColor,
  ThemePaletteColors,
  ThemeSeedColors,
  ThemeVariant,
} from "./types"

const SEED_KEYS = [
  "neutral",
  "primary",
  "success",
  "warning",
  "error",
  "info",
  "interactive",
  "diffAdd",
  "diffDelete",
] as const
const PALETTE_KEYS = ["neutral", "ink", "primary", "success", "warning", "error", "info"] as const
const OPTIONAL_PALETTE_KEYS = ["accent", "interactive", "diffAdd", "diffDelete"] as const

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && value.startsWith("#")
}

function isCssVarRef(value: unknown): value is CssVarRef {
  return typeof value === "string" && value.startsWith("var(--") && value.endsWith(")")
}

function isColorValue(value: unknown): value is ColorValue {
  return isHexColor(value) || isCssVarRef(value)
}

/** Checks the DesktopTheme shape, including every seed, palette and override color. */
export function isDesktopTheme(value: unknown): value is DesktopTheme {
  return (
    isRecord(value) &&
    (value.$schema === undefined || typeof value.$schema === "string") &&
    typeof value.name === "string" &&
    typeof value.id === "string" &&
    isThemeVariant(value.light) &&
    isThemeVariant(value.dark)
  )
}

/** Narrows parsed theme JSON to DesktopTheme, or throws a SchemaError when the JSON does not match. */
export function parseDesktopTheme(value: unknown): DesktopTheme {
  const id = isRecord(value) && typeof value.id === "string" ? value.id : "<unknown>"
  const schema = Schema.declare(isDesktopTheme, {
    identifier: "DesktopTheme",
    message: `Theme "${id}" does not match the DesktopTheme type`,
  })
  return Schema.decodeUnknownSync(schema)(value)
}

function isThemeVariant(value: unknown): value is ThemeVariant {
  if (!isRecord(value)) return false
  const colors = isSeedColors(value.seeds)
    ? value.palette === undefined
    : isPaletteColors(value.palette) && value.seeds === undefined
  return (
    colors &&
    (value.overrides === undefined || isRecordOf(value.overrides, isColorValue)) &&
    (value.v2Overrides === undefined || isRecordOf(value.v2Overrides, isString))
  )
}

function isSeedColors(value: unknown): value is ThemeSeedColors {
  return isRecord(value) && SEED_KEYS.every((key) => isHexColor(value[key]))
}

function isPaletteColors(value: unknown): value is ThemePaletteColors {
  return (
    isRecord(value) &&
    PALETTE_KEYS.every((key) => isHexColor(value[key])) &&
    OPTIONAL_PALETTE_KEYS.every((key) => value[key] === undefined || isHexColor(value[key]))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  return !Array.isArray(value)
}

function isRecordOf<T>(value: unknown, item: (entry: unknown) => entry is T): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(item)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}
