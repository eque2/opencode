import type { DesktopTheme } from "./types"
import { parseDesktopTheme } from "./validate"
import oc2ThemeJson from "./themes/oc-2.json"
import amoledThemeJson from "./themes/amoled.json"
import auraThemeJson from "./themes/aura.json"
import ayuThemeJson from "./themes/ayu.json"
import carbonfoxThemeJson from "./themes/carbonfox.json"
import catppuccinThemeJson from "./themes/catppuccin.json"
import catppuccinFrappeThemeJson from "./themes/catppuccin-frappe.json"
import catppuccinMacchiatoThemeJson from "./themes/catppuccin-macchiato.json"
import cobalt2ThemeJson from "./themes/cobalt2.json"
import cursorThemeJson from "./themes/cursor.json"
import draculaThemeJson from "./themes/dracula.json"
import everforestThemeJson from "./themes/everforest.json"
import flexokiThemeJson from "./themes/flexoki.json"
import githubThemeJson from "./themes/github.json"
import gruvboxThemeJson from "./themes/gruvbox.json"
import kanagawaThemeJson from "./themes/kanagawa.json"
import lucentOrngThemeJson from "./themes/lucent-orng.json"
import materialThemeJson from "./themes/material.json"
import matrixThemeJson from "./themes/matrix.json"
import mercuryThemeJson from "./themes/mercury.json"
import monokaiThemeJson from "./themes/monokai.json"
import nightowlThemeJson from "./themes/nightowl.json"
import nordThemeJson from "./themes/nord.json"
import oneDarkThemeJson from "./themes/one-dark.json"
import oneDarkProThemeJson from "./themes/onedarkpro.json"
import opencodeThemeJson from "./themes/opencode.json"
import orngThemeJson from "./themes/orng.json"
import osakaJadeThemeJson from "./themes/osaka-jade.json"
import palenightThemeJson from "./themes/palenight.json"
import rosepineThemeJson from "./themes/rosepine.json"
import shadesOfPurpleThemeJson from "./themes/shadesofpurple.json"
import solarizedThemeJson from "./themes/solarized.json"
import synthwave84ThemeJson from "./themes/synthwave84.json"
import tokyonightThemeJson from "./themes/tokyonight.json"
import vercelThemeJson from "./themes/vercel.json"
import vesperThemeJson from "./themes/vesper.json"
import zenburnThemeJson from "./themes/zenburn.json"

export const oc2Theme = parseDesktopTheme(oc2ThemeJson)
export const amoledTheme = parseDesktopTheme(amoledThemeJson)
export const auraTheme = parseDesktopTheme(auraThemeJson)
export const ayuTheme = parseDesktopTheme(ayuThemeJson)
export const carbonfoxTheme = parseDesktopTheme(carbonfoxThemeJson)
export const catppuccinTheme = parseDesktopTheme(catppuccinThemeJson)
export const catppuccinFrappeTheme = parseDesktopTheme(catppuccinFrappeThemeJson)
export const catppuccinMacchiatoTheme = parseDesktopTheme(catppuccinMacchiatoThemeJson)
export const cobalt2Theme = parseDesktopTheme(cobalt2ThemeJson)
export const cursorTheme = parseDesktopTheme(cursorThemeJson)
export const draculaTheme = parseDesktopTheme(draculaThemeJson)
export const everforestTheme = parseDesktopTheme(everforestThemeJson)
export const flexokiTheme = parseDesktopTheme(flexokiThemeJson)
export const githubTheme = parseDesktopTheme(githubThemeJson)
export const gruvboxTheme = parseDesktopTheme(gruvboxThemeJson)
export const kanagawaTheme = parseDesktopTheme(kanagawaThemeJson)
export const lucentOrngTheme = parseDesktopTheme(lucentOrngThemeJson)
export const materialTheme = parseDesktopTheme(materialThemeJson)
export const matrixTheme = parseDesktopTheme(matrixThemeJson)
export const mercuryTheme = parseDesktopTheme(mercuryThemeJson)
export const monokaiTheme = parseDesktopTheme(monokaiThemeJson)
export const nightowlTheme = parseDesktopTheme(nightowlThemeJson)
export const nordTheme = parseDesktopTheme(nordThemeJson)
export const oneDarkTheme = parseDesktopTheme(oneDarkThemeJson)
export const oneDarkProTheme = parseDesktopTheme(oneDarkProThemeJson)
export const opencodeTheme = parseDesktopTheme(opencodeThemeJson)
export const orngTheme = parseDesktopTheme(orngThemeJson)
export const osakaJadeTheme = parseDesktopTheme(osakaJadeThemeJson)
export const palenightTheme = parseDesktopTheme(palenightThemeJson)
export const rosepineTheme = parseDesktopTheme(rosepineThemeJson)
export const shadesOfPurpleTheme = parseDesktopTheme(shadesOfPurpleThemeJson)
export const solarizedTheme = parseDesktopTheme(solarizedThemeJson)
export const synthwave84Theme = parseDesktopTheme(synthwave84ThemeJson)
export const tokyonightTheme = parseDesktopTheme(tokyonightThemeJson)
export const vercelTheme = parseDesktopTheme(vercelThemeJson)
export const vesperTheme = parseDesktopTheme(vesperThemeJson)
export const zenburnTheme = parseDesktopTheme(zenburnThemeJson)

export const DEFAULT_THEMES: Record<string, DesktopTheme> = {
  "oc-2": oc2Theme,
  amoled: amoledTheme,
  aura: auraTheme,
  ayu: ayuTheme,
  carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme,
  "catppuccin-frappe": catppuccinFrappeTheme,
  "catppuccin-macchiato": catppuccinMacchiatoTheme,
  cobalt2: cobalt2Theme,
  cursor: cursorTheme,
  dracula: draculaTheme,
  everforest: everforestTheme,
  flexoki: flexokiTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  kanagawa: kanagawaTheme,
  "lucent-orng": lucentOrngTheme,
  material: materialTheme,
  matrix: matrixTheme,
  mercury: mercuryTheme,
  monokai: monokaiTheme,
  nightowl: nightowlTheme,
  nord: nordTheme,
  "one-dark": oneDarkTheme,
  onedarkpro: oneDarkProTheme,
  opencode: opencodeTheme,
  orng: orngTheme,
  "osaka-jade": osakaJadeTheme,
  palenight: palenightTheme,
  rosepine: rosepineTheme,
  shadesofpurple: shadesOfPurpleTheme,
  solarized: solarizedTheme,
  synthwave84: synthwave84Theme,
  tokyonight: tokyonightTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
  zenburn: zenburnTheme,
}
