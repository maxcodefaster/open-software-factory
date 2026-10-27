import { render } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { AgentMessage, ConversationEntry } from "../../apps/factory/src/api-contracts";
import { conversationViewSchema } from "../../apps/factory/src/api-contracts";
import { composerKeyDown } from "../../apps/factory/src/assistant-interaction";
import { groupConversationActivities } from "../../apps/factory/src/conversation-activity";
import {
  ChangeAgentActivityGroup,
  ChangeAgentMessage,
  ConversationEntryCard,
} from "../../apps/factory/src/conversation-components";
import { ConversationSwitcher } from "../../apps/factory/src/conversation-switcher";
import { conversationTimeline } from "../../apps/factory/src/conversation-timeline";
import { ChatSkillPicker } from "../../apps/factory/src/skills/chat-picker";
import { ChangeWriterStatus } from "../../apps/factory/src/writer-status";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const initial: AgentMessage[] = [
  { id: "human", role: "user", text: "Keep the **current layout**.", at: 1 },
  {
    id: "answer",
    role: "assistant",
    text: "I will keep the layout and inspect the affected files.",
    at: 2,
  },
  {
    id: "read",
    role: "tool",
    text: "Read src/view.tsx",
    at: 3,
    activity: {
      name: "read",
      status: "completed",
      detail: "Existing view source.",
      navigation: { path: "src/view.tsx", diff: "-before\n+after" },
    },
  },
  {
    id: "shell",
    role: "tool",
    text: "bun test src/view.test.ts",
    at: 4,
    activity: {
      name: "shell",
      status: "running",
      detail: "Running view checks.",
      truncated: true,
    },
  },
  {
    id: "failure",
    role: "tool",
    text: "bun test src/access.test.ts",
    at: 5,
    activity: { name: "shell", status: "error", detail: "The access check failed." },
  },
];

function Surface() {
  const long = new URLSearchParams(location.search).has("long");
  const title = long
    ? "Review billing permissions and the shared implementation across every customer workspace"
    : "Keep the current layout";
  const [messages, setMessages] = createSignal(initial);
  const [sent, setSent] = createSignal(0);
  const [opened, setOpened] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [fresh, setFresh] = createSignal(0);
  const [running, setRunning] = createSignal(false);
  const [structured, setStructured] = createSignal(false);
  const question: ConversationEntry = {
    id: "10000000-0000-4000-8000-000000000009",
    ordinal: 10,
    kind: "question",
    actor: "project-agent",
    mode: "plan",
    body: "Which scope should change?",
    payload: {
      message: "A clarification",
      question: {
        type: "free-text",
        prompt: "Which scope should change?",
        placeholder: "Your answer",
      },
    },
    citations: [],
    inReplyToEntryId: undefined,
    requirementRevisionId: undefined,
    createdAt: "2026-10-23T10:00:00Z",
  };
  const contextID = "10000000-0000-4000-8000-000000000008";
  const context = () =>
    conversationViewSchema.parse({
      id: "10000000-0000-4000-8000-000000000007",
      projectId: "10000000-0000-4000-8000-000000000001",
      mode: "build",
      version: 1,
      contextId: selected(),
      activeCodingContextId: contextID,
      entries: [],
      contexts: [
        {
          id: contextID,
          kind: "coding",
          title: "Fresh Coding",
          ordinal: 2,
          original: false,
          createdAt: "2026-10-23T10:00:00Z",
        },
        ...(long
          ? Array.from({ length: 24 }, (_, index) => ({
              id: `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
              kind: "research",
              title: `Research conversation ${index + 3}`,
              ordinal: index + 3,
              original: false,
              createdAt: "2026-10-23T10:00:00Z",
            }))
          : []),
      ],
    });
  const timeline = createMemo(() =>
    groupConversationActivities(conversationTimeline([], messages())),
  );
  return (
    <main class="factory-desktop agent-is-open" data-background="river-landscape">
      <header class="factory-topbar">
        <span class="context-button">Chat collaboration · scripted test data</span>
      </header>
      <section class="workspace-window">
        <header>
          <h1>Keep the current layout</h1>
        </header>
        <div style="padding: var(--space-4); display: flex; flex-wrap: wrap; gap: var(--space-2);">
          <button
            type="button"
            class="quiet-button"
            onClick={() =>
              setMessages((items) =>
                items.map((item) =>
                  item.id === "shell"
                    ? {
                        ...item,
                        activity: {
                          ...fixtureValue(item.activity, "item.activity"),
                          status: "completed",
                        },
                      }
                    : item,
                ),
              )
            }
          >
            Complete command
          </button>
          <button
            type="button"
            class="quiet-button"
            onClick={() =>
              setMessages((items) =>
                items.map((item) => ({
                  ...item,
                  ...(item.activity ? { activity: { ...item.activity } } : {}),
                })),
              )
            }
          >
            Reconnect snapshot
          </button>
          <button type="button" class="quiet-button" onClick={() => setRunning((value) => !value)}>
            Toggle busy Coding
          </button>
          <p role="status">
            Opened activity: {opened() || "none"} · Fresh contexts: {fresh()}
          </p>
          <button type="button" class="quiet-button" onClick={() => setStructured(true)}>
            Show structured messages
          </button>
        </div>
      </section>
      <aside class="agent-panel" aria-label="Coding conversation">
        <ConversationSwitcher
          title={title}
          onMinimize={() => setOpened("minimized")}
          conversation={context()}
          ticket
          coding
          canRestart={!running()}
          busy={false}
          onSelect={(id) => setSelected(id === "original" ? null : id)}
          onResearch={() => setOpened("new Project question")}
          onCoding={() => {
            setFresh((value) => value + 1);
            setSelected(contextID);
          }}
        />
        <div class="agent-messages conversation-history">
          <For each={timeline()} keyed={(item) => item.id}>
            {(item) => {
              const group = () => {
                const current = item();
                return current.kind === "activity-group" ? current.messages : undefined;
              };
              const message = () => {
                const current = item();
                return current.kind === "change-agent" ? current.message : undefined;
              };
              return (
                <Show
                  when={group()}
                  fallback={
                    <Show when={message()}>
                      {(value) => (
                        <ChangeAgentMessage
                          message={value()}
                          onNavigate={(message, kind) =>
                            setOpened(`${kind} ${message.activity?.navigation?.path}`)
                          }
                        />
                      )}
                    </Show>
                  }
                >
                  {(value) => (
                    <ChangeAgentActivityGroup
                      messages={value()}
                      onNavigate={(message, kind) =>
                        setOpened(`${kind} ${message.activity?.navigation?.path}`)
                      }
                    />
                  )}
                </Show>
              );
            }}
          </For>
          <Show when={structured()}>
            <For
              each={[
                question,
                {
                  ...question,
                  id: "10000000-0000-4000-8000-000000000010",
                  kind: "requirement" as const,
                  body: "Review the **requirements**.",
                  payload: {},
                },
              ]}
            >
              {(entry) => (
                <ConversationEntryCard
                  entry={entry}
                  answered={false}
                  answerSummary={undefined}
                  requirementApproved={false}
                  requirementCurrent
                  canAnswer={false}
                  pending={false}
                  initialAnswer={undefined}
                  answerStorageKey="scripted-question"
                  onAnswer={() => setSent((value) => value + 1)}
                  onPause={() => {}}
                  onResume={() => setSent((value) => value + 1)}
                  requirementVisible
                  onReviewRequirements={() => {}}
                  onCitation={() => {}}
                />
              )}
            </For>
          </Show>
        </div>
        <ChangeWriterStatus changeID="10000000-0000-4000-8000-000000000003" active />
        <div class="agent-input-shell">
          <form
            class="agent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              setSent((value) => value + 1);
            }}
          >
            <textarea aria-label="Message draft" onKeyDown={composerKeyDown} />
            <div class="agent-compose-toolbar">
              <ChatSkillPicker
                projectID="10000000-0000-4000-8000-000000000001"
                workType="build"
                scope="owned-coding"
              />
              <button class="agent-control primary" type="submit">
                Send
              </button>
            </div>
          </form>
          <span class="sr-only" role="status">
            Messages sent: {sent()}
          </span>
        </div>
      </aside>
    </main>
  );
}

render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
