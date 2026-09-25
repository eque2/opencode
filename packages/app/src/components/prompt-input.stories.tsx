// @ts-nocheck
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { createPromptState } from "@/context/prompt"
import { SessionComposerRegion, createSessionComposerRegionController } from "@/pages/session/composer"
import type {
  SessionComposerFollowupDock,
  SessionComposerRevertDock,
} from "@/pages/session/composer/session-composer-region-controller"
import { createPromptInputHistory, PromptInput } from "./prompt-input"

// Story state leaves an absent value out of the store; reading the missing key gives the undefined the
// prompt controls expect.
type PromptInputStoryControls = {
  agent: string
  variant?: string
  comments: number
  tabs: string[]
  activeTab?: string
  reviewOpen: boolean
}

type PromptInputDockStoryControls = {
  agent: string
  variant?: string
  activeTab?: string
  todoCollapsed: boolean
  questionRequest?: QuestionRequest
  permissionRequest?: PermissionRequest
  followup?: SessionComposerFollowupDock
  revert?: SessionComposerRevertDock
}

function createPromptInputStoryRuntime() {
  const state = createPromptState()
  return {
    state,
    history: createPromptInputHistory(),
    submission: {
      abort() {},
      handleSubmit(event: Event) {
        event.preventDefault()
        state.reset()
      },
    },
  }
}

function PromptInputExample() {
  const input = createPromptInputStoryRuntime()
  const [controls, setControls] = createStore<PromptInputStoryControls>({
    agent: "build",
    comments: 0,
    tabs: [],
    reviewOpen: false,
  })
  const storyModel = {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: { id: "anthropic", name: "Anthropic" },
  }
  const model = {
    current: () => storyModel,
    list: () => [storyModel],
    visible: () => true,
    set: () => {},
    variant: {
      list: () => ["fast", "thinking"],
      current: () => controls.variant,
      set: (variant?: string) => setControls("variant", variant),
    },
  }
  const inputControls = {
    agents: {
      available: [{ name: "review", hidden: false, mode: "subagent" }],
      options: ["build", "review", "plan"],
      get current() {
        return controls.agent
      },
      loading: false,
      visible: true,
      select: (agent?: string) => setControls("agent", agent ?? "build"),
    },
    model: {
      selection: model,
      paid: true,
      loading: false,
    },
    session: {
      id: "story-session",
      tabs: {
        active: () => controls.activeTab,
        all: () => controls.tabs,
        open: (tab: string) => setControls("tabs", (tabs) => (tabs.includes(tab) ? tabs : [...tabs, tab])),
        setActive: (tab: string) => setControls("activeTab", tab),
      },
      reviewPanel: {
        opened: () => controls.reviewOpen,
        open: () => setControls("reviewOpen", true),
      },
    },
  }
  const addReviewComment = () => {
    const comment = controls.comments + 1
    setControls("comments", comment)
    input.state.context.add({
      type: "file",
      path: "src/components/prompt-input.tsx",
      selection: {
        startLine: 84 + comment,
        startChar: 0,
        endLine: 84 + comment,
        endChar: 0,
      },
      comment: `Review comment ${comment}`,
      commentID: `review-comment-${comment}`,
      commentOrigin: "review",
      preview: "export const PromptInput = ...",
    })
  }

  return (
    <div class="flex flex-col gap-3">
      <PromptInput controls={inputControls} {...input} />
      <div>
        <button
          type="button"
          class="rounded-md border border-border-weak-base bg-background-base px-2.5 py-1.5 text-12-medium text-text-base hover:bg-background-stronger"
          onClick={addReviewComment}
        >
          Add review comment
        </button>
      </div>
    </div>
  )
}

const todos: Todo[] = [
  { id: "todo-1", content: "Inspect the session composer animation", status: "completed" },
  { id: "todo-2", content: "Keep the dock settled on initial render", status: "in_progress" },
  { id: "todo-3", content: "Verify session navigation behavior", status: "pending" },
]

function PromptInputWithOpenDock() {
  const input = createPromptInputStoryRuntime()
  const [controls, setControls] = createStore<PromptInputDockStoryControls>({
    agent: "build",
    todoCollapsed: false,
  })
  const inputControls = {
    agents: {
      available: [],
      options: ["build"],
      get current() {
        return controls.agent
      },
      loading: false,
      visible: true,
      select: (agent?: string) => setControls("agent", agent ?? "build"),
    },
    model: {
      selection: {
        current: () => ({ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", provider: { id: "anthropic" } }),
        variant: { list: () => [], current: () => controls.variant, set: () => {} },
      },
      paid: true,
      loading: false,
    },
    session: {
      id: "story-session",
      tabs: {
        active: () => controls.activeTab,
        all: () => [],
        open: () => {},
        setActive: (tab: string) => setControls("activeTab", tab),
      },
      reviewPanel: { opened: () => false, open: () => {} },
    },
  }
  const state = {
    blocked: () => false,
    questionRequest: () => controls.questionRequest,
    permissionRequest: () => controls.permissionRequest,
    permissionResponding: () => false,
    decide: () => {},
    todos: () => todos,
    dock: () => true,
    closing: () => false,
    opening: () => false,
  }
  return (
    <SessionComposerRegion
      controller={createSessionComposerRegionController({
        state,
        sessionKey: () => "story-session",
        sessionID: () => "story-session",
        prompt: input.state,
        ready: () => true,
        centered: () => false,
        todo: {
          collapsed: () => controls.todoCollapsed,
          onToggle: () => setControls("todoCollapsed", (collapsed) => !collapsed),
        },
        followup: () => controls.followup,
        revert: () => controls.revert,
        onResponseSubmit: () => {},
        openParent: () => {},
        setPromptRef: () => {},
        setDockRef: () => {},
      })}
      promptInput={
        <PromptInput
          controls={inputControls}
          {...input}
          ref={() => {}}
          newSessionWorktree=""
          onNewSessionWorktreeReset={() => {}}
        />
      }
    />
  )
}

export default {
  title: "App/PromptInput",
  id: "app-prompt-input",
  component: PromptInput,
}

export const Basic = {
  render: () => (
    <div class="pt-10">
      <h1 class="mb-4">Prompt Input</h1>
      <PromptInputExample />
    </div>
  ),
}

export const DockAlreadyOpen = {
  render: () => (
    <div class="pt-10">
      <h1 class="mb-4">Prompt Input with open Todo dock</h1>
      <PromptInputWithOpenDock />
    </div>
  ),
}
