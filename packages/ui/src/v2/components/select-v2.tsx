import { Select as Kobalte } from "@kobalte/core/select"
import { MutableHashMap, Option, Predicate } from "effect"
import { Show, createMemo, onCleanup, splitProps, type ComponentProps, type JSX } from "solid-js"
import "./select-v2.css"

function groupOptions<T>(options: T[], groupBy?: (x: T) => string): { category: string; options: T[] }[] {
  if (!groupBy) {
    return [{ category: "", options }]
  }
  // MutableHashMap iterates in insertion order, so groups keep their first-seen order.
  const groups = MutableHashMap.empty<string, T[]>()
  for (const opt of options) {
    const key = groupBy(opt)
    const arr = MutableHashMap.get(groups, key)
    if (Option.isSome(arr)) arr.value.push(opt)
    else MutableHashMap.set(groups, key, [opt])
  }
  return [...groups].map(([category, opts]) => ({ category, options: opts }))
}

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M11 9.5L8 6.5L5 9.5"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

const CheckSmall = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export type SelectV2Props<T> = Omit<
  ComponentProps<typeof Kobalte<T, { category: string; options: T[] }>>,
  "value" | "onSelect" | "children" | "options" | "itemComponent" | "sectionComponent" | "defaultValue" | "multiple"
> & {
  placeholder?: string
  options: T[]
  /** Selected option (single selection). */
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  groupBy?: (x: T) => string
  onSelect?: (value: T | null) => void
  onHighlight?: (value: T | undefined) => void | (() => void)
  /** `base` / `large` match text-input-v2; `inline` is a compact settings-row trigger. */
  appearance?: "base" | "large" | "inline"
  invalid?: boolean
  numeric?: boolean
  children?: (item: T) => JSX.Element
  valueClass?: string
}

export function SelectV2<T>(props: SelectV2Props<T>) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "groupBy",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "children",
    "appearance",
    "invalid",
    "numeric",
    "disabled",
    "valueClass",
    "placement",
    "gutter",
    "sameWidth",
    "flip",
    "slide",
    "fitViewport",
  ])

  const inline = () => (local.appearance ?? "base") === "inline"

  const state: { key?: string; cleanup?: void | (() => void) } = {}

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : String(item))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }
    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)

  const grouped = createMemo(() => groupOptions(local.options, local.groupBy))

  return (
    <Kobalte<T, { category: string; options: T[] }>
      {...others}
      multiple={false}
      allowDuplicateSelectionEvents={false}
      disabled={local.disabled}
      data-component="select-v2-root"
      placement={local.placement ?? (inline() ? "bottom-end" : "bottom-start")}
      gutter={local.gutter ?? 4}
      sameWidth={local.sameWidth ?? !inline()}
      flip={local.flip ?? true}
      slide={local.slide ?? true}
      fitViewport={local.fitViewport ?? false}
      value={local.current}
      options={grouped()}
      optionValue={(x) => (local.value ? local.value(x) : String(x))}
      optionTextValue={(x) => (local.label ? local.label(x) : String(x))}
      optionGroupChildren="options"
      placeholder={local.placeholder}
      sectionComponent={(sectionProps) => (
        <Kobalte.Section>
          <Show when={sectionProps.section.rawValue.category}>
            <div data-slot="menu-v2-group-label">{sectionProps.section.rawValue.category}</div>
          </Show>
        </Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          {...itemProps}
          data-component="menu-v2-item"
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
          onFocus={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="menu-v2-item-content" as="span">
            {local.children
              ? local.children(itemProps.item.rawValue)
              : local.label
                ? local.label(itemProps.item.rawValue)
                : String(itemProps.item.rawValue)}
          </Kobalte.ItemLabel>
          <Kobalte.ItemIndicator data-slot="menu-v2-item-indicator" forceMount>
            <CheckSmall />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      onChange={(next) => {
        local.onSelect?.(next)
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) stop()
      }}
    >
      <Kobalte.Trigger
        as="div"
        data-component="select-v2"
        data-appearance={local.appearance ?? "base"}
        data-invalid={local.invalid ? "" : undefined}
        bool:data-numeric={!!local.numeric}
        disabled={local.disabled}
        bool:data-disabled={!!local.disabled}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
      >
        <div data-slot="select-v2-value">
          <Kobalte.Value<T> data-slot="select-v2-value-text" class={local.valueClass}>
            {(st) => {
              const selected = st.selectedOption()
              if (local.label && Predicate.isNotNullish(selected)) return local.label(selected)
              return Predicate.isNotNullish(selected) ? String(selected) : ""
            }}
          </Kobalte.Value>
        </div>
        <span data-slot="select-v2-chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content data-component="menu-v2-content" data-slot="select-v2-content">
          <Kobalte.Listbox data-slot="select-v2-listbox" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
