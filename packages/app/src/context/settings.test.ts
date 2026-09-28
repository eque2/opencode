import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  hasExistingWebState,
  initialAgentVisibility,
  isAppUpgrade,
  layoutTransitionState,
  maximumSunsetTimeout,
  newLayoutDesignsDefault,
  nextSunsetCheckDelay,
  resolveNewLayoutDesigns,
  shouldDisplayTabsToast,
  shouldEnableNewLayout,
} from "./settings"

describe("agent visibility", () => {
  test("shows the picker for existing profiles and hides it for first-time installs", () => {
    expect(initialAgentVisibility(Option.none(), true, Option.none())).toEqual(Option.some(true))
    expect(initialAgentVisibility(Option.none(), false, Option.none())).toEqual(Option.some(false))
  })

  test("shows the picker when updating from a recent release", () => {
    expect(initialAgentVisibility(Option.none(), false, Option.some("1.18.8"))).toEqual(Option.some(true))
  })

  test("preserves the preference after initialization", () => {
    expect(initialAgentVisibility(Option.some(true), true, Option.some("1.18.8"))).toEqual(Option.none())
    expect(initialAgentVisibility(Option.some(true), false, Option.none())).toEqual(Option.none())
  })
})

describe("layout transition", () => {
  test("blank profiles default to the new layout", () => {
    expect(newLayoutDesignsDefault).toBe(true)
  })

  test("hides the transition until a sunset is scheduled", () => {
    expect(layoutTransitionState(false, true, false, false)).toEqual({ available: false, notice: false })
  })

  test("existing profiles can switch before sunset", () => {
    expect(layoutTransitionState(true, true, false, false)).toEqual({ available: true, notice: false })
  })

  test("classifies web profiles from existing settings or a recorded version", () => {
    expect(hasExistingWebState(Option.some("{}"), Option.none())).toBe(true)
    expect(hasExistingWebState(Option.none(), Option.some("1.17.19"))).toBe(true)
    expect(hasExistingWebState(Option.none(), Option.none())).toBe(false)
  })

  test("preserves explicit and default layout preferences", () => {
    expect(resolveNewLayoutDesigns(false, Option.some(false), true)).toBe(false)
    expect(resolveNewLayoutDesigns(false, Option.none(), false)).toBe(false)
    expect(resolveNewLayoutDesigns(false, Option.none(), true)).toBe(true)
  })

  test("sunset replaces the toggle with a dismissible notice", () => {
    expect(layoutTransitionState(true, true, true, false)).toEqual({ available: false, notice: true })
    expect(layoutTransitionState(true, true, true, true)).toEqual({ available: false, notice: false })
    expect(resolveNewLayoutDesigns(true, Option.some(false))).toBe(true)
  })

  test("caps checks for sunsets beyond the browser timeout limit", () => {
    expect(nextSunsetCheckDelay(maximumSunsetTimeout + 1_000, 0)).toBe(maximumSunsetTimeout)
    expect(nextSunsetCheckDelay(10_000, 9_000)).toBe(1_000)
    expect(nextSunsetCheckDelay(9_000, 10_000)).toBe(0)
  })

  test("enables the new layout when upgrading from 1.17.19 or earlier", () => {
    expect(shouldEnableNewLayout(Option.some("v1.17.19"), Option.some("1.17.20"))).toBe(true)
    expect(shouldEnableNewLayout(Option.some("1.16.9"), Option.some("2.0.0"))).toBe(true)
  })

  test("enables the new layout when no previous version was recorded", () => {
    expect(shouldEnableNewLayout(Option.none(), Option.some("1.17.20"))).toBe(true)
  })

  test("detects upgrades only when a previous version is older", () => {
    expect(isAppUpgrade(Option.some("1.17.19"), Option.some("1.17.20"))).toBe(true)
    expect(isAppUpgrade(Option.none(), Option.some("1.17.20"))).toBe(false)
    expect(isAppUpgrade(Option.some("1.17.20"), Option.some("1.17.20"))).toBe(false)
    expect(isAppUpgrade(Option.some("1.17.21"), Option.some("1.17.20"))).toBe(false)
  })

  test("shows the tabs toast for upgrades and existing installs without a recorded version", () => {
    expect(shouldDisplayTabsToast(Option.some("1.17.19"), Option.some("1.17.20"), false)).toBe(true)
    expect(shouldDisplayTabsToast(Option.none(), Option.some("1.17.20"), true)).toBe(true)
    expect(shouldDisplayTabsToast(Option.none(), Option.some("1.17.20"), false)).toBe(false)
  })

  test("does not enable the new layout without a qualifying upgrade", () => {
    expect(shouldEnableNewLayout(Option.some("1.17.19"), Option.some("1.17.19"))).toBe(false)
    expect(shouldEnableNewLayout(Option.some("1.17.20"), Option.some("1.17.21"))).toBe(false)
    expect(shouldEnableNewLayout(Option.none(), Option.some("1.17.19"))).toBe(false)
    expect(shouldEnableNewLayout(Option.some("dev"), Option.some("1.17.20"))).toBe(false)
  })
})
