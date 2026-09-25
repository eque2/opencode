import type { Config, Session, Todo } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"

const provider = {
  all: [
    {
      id: "anthropic",
      models: {
        "claude-3-7-sonnet": {
          id: "claude-3-7-sonnet",
          name: "Claude 3.7 Sonnet",
          cost: { input: 1, output: 1 },
        },
      },
    },
  ],
  connected: ["anthropic"],
  default: { anthropic: "claude-3-7-sonnet" },
}

type MockChildStore = {
  todo: Record<string, Todo[]>
  provider: typeof provider
  session: Session[]
  config: Pick<Config, "permission">
}

const [store, setStore] = createStore<MockChildStore>({
  todo: {},
  provider,
  session: [],
  config: { permission: {} },
})

export function useServerSync() {
  return {
    data: {
      provider,
      session_todo: store.todo,
    },
    child() {
      return [store, setStore] as const
    },
    todo: {
      set(sessionID: string, todos: Todo[]) {
        setStore("todo", sessionID, todos)
      },
    },
  }
}

export function useQueryOptions() {
  return {
    agents: (directory: string) => ({
      queryKey: [directory, "agents"],
      queryFn: async () => [],
    }),
    providers: (directory: string | null) => ({
      queryKey: [directory, "providers"],
      queryFn: async () => provider,
    }),
  }
}
