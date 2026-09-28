import { ErrorBoundary, type Component, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"

// A story module exports its components as functions. JavaScript cannot check
// the props or the return type of a function at run time, so typeof is the check.
function isComponent(value: unknown): value is Component<Record<string, unknown>> {
  return typeof value === "function"
}

function pick(mod: Record<string, unknown>, name?: string): ValidComponent {
  if (name) {
    const named = mod[name]
    if (isComponent(named)) return named
  }
  if (isComponent(mod.default)) return mod.default

  const preferred = Object.keys(mod)
    .filter((k) => k[0] && k[0] === k[0].toUpperCase())
    .map((k) => mod[k])
    .find(isComponent)
  if (preferred) return preferred

  const first = Object.values(mod).find(isComponent)
  if (first) return first

  return () => {
    return (
      <div data-component="storybook-missing">
        <div>Missing component export.</div>
        <div style="opacity:0.7;font-size:12px">Exports: {Object.keys(mod).join(", ") || "(none)"}</div>
      </div>
    )
  }
}

export function create(input: {
  title: string
  mod: Record<string, unknown>
  name?: string
  args?: Record<string, unknown>
}) {
  const component = pick(input.mod, input.name)

  return {
    meta: {
      title: input.title,
      component,
    },
    Basic: {
      args: input.args ?? {},
      render: (args: Record<string, unknown>) => {
        return (
          <ErrorBoundary
            fallback={(err) => {
              return (
                <pre data-component="storybook-error" style="white-space:pre-wrap">
                  {String(err)}
                </pre>
              )
            }}
          >
            <Dynamic component={component} {...args} />
          </ErrorBoundary>
        )
      },
    },
  }
}
