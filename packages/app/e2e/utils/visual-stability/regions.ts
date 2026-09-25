import { Record } from "effect"

export type VisualRegionDefinition = {
  selector: string
  closest?: string
  opacitySelectors?: readonly string[]
}

export function defineVisualRegions<const Regions extends Record<string, VisualRegionDefinition>>(regions: Regions) {
  return regions
}

export function mapVisualRegions<const Regions extends Record<string, VisualRegionDefinition>, Result>(
  regions: Regions,
  map: (region: Regions[keyof Regions], name: keyof Regions) => Result,
) {
  return Record.map<Extract<keyof Regions, string>, Regions[keyof Regions], Result>(regions, map)
}
