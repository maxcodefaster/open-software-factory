import { render } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { AgentMessage } from "../../apps/factory/src/api-contracts";
import { groupConversationActivities } from "../../apps/factory/src/conversation-activity";
import {
  ChangeAgentActivityGroup,
  ChangeAgentMessage,
} from "../../apps/factory/src/conversation-components";
import { conversationTimeline } from "../../apps/factory/src/conversation-timeline";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const query = new URLSearchParams(location.search);
const stopped = query.has("stopped");
const rich = `## Ergebnis

Ein **fetter** Text, \`inline code\` und ein [Link](https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/without/any/break/at/all/until/the/end).

| Bereich | Status | Hinweis |
| --- | --- | --- |
| Vorschau | Bereit | Läuft auf Port 4321 mit einem sehr langen Text in der Zelle, der nicht umbrechen soll |
| API | Fehler | \`ERR_CONNECTION_REFUSED\` |

\`\`\`ts
export async function resolveEditorApi(origin: string, sandbox: string): Promise<URL> {
  return new URL(\`/__factory/sandbox/\${sandbox}/api/admin/auth/config?cache=bust&very=long\`, origin);
}
\`\`\`

- Punkt eins
  - verschachtelt

Lange URL: https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const tool = (
  id: string,
  at: number,
  name: string,
  text: string,
  status: "pending" | "running" | "completed" | "error" | "streaming",
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({
    id,
    role: "tool",
    text,
    at,
    activity: { name, status, detail: extra["detail"] ?? "", ...extra },
  }) as AgentMessage;
const messages: AgentMessage[] = [
  {
    id: "u1",
    role: "user",
    text: "Bitte prüfe die **Preview-Anbindung** und behebe den Fehler.",
    at: 1,
  },
  { id: "a1", role: "assistant", text: rich, at: 2 },
  tool("t1", 3, "read", "Read apps/factory/src/knowledge-workspace.tsx", "completed", {
    detail: "992 lines",
    navigation: { path: "apps/factory/src/knowledge-workspace.tsx", diff: "-a\n+b" },
  }),
  tool("t2", 4, "grep", 'Search "createSignal" in apps/factory/src', "completed", {
    detail: "41 matches",
  }),
  tool(
    "t3",
    5,
    "shell",
    "bun test apps/factory/src/knowledge --coverage --reporter=junit --reporter-outfile=/tmp/some/really/long/path/that/never/ends/without/spaces/results.xml",
    "completed",
    {
      detail: "12 pass\n0 fail",
      truncated: true,
    },
  ),
  tool("t4", 6, "edit", "Edit apps/factory/src/style.css", "completed", {
    detail: "1 hunk",
    navigation: { path: "apps/factory/src/style.css" },
  }),
  tool("t5", 7, "shell", "pnpm check", "error", {
    detail: "error TS2322: Type 'string' is not assignable to type 'number'.\n  at src/a.ts:1:1",
  }),
  tool("t6", 8, "shell", "pnpm build", "running", { detail: "Building…" }),
  tool("t7", 9, "shell", "pnpm lint", "pending", {}),
  {
    id: "a2",
    role: "assistant",
    text: "Der Build läuft noch. Ich melde mich, sobald die Prüfung abgeschlossen ist.",
    at: 10,
  },
  tool("t8", 11, "shell", "git status --short", "completed", { detail: " M a.ts" }),
  {
    id: "u2",
    role: "user",
    text: "Danke. " + "Überprüfung der Größenänderung für äußerst lange Überschriften. ".repeat(6),
    at: 12,
  },
  { id: "a3", role: "assistant", text: "[…] Shortened.", at: 13, truncated: true } as AgentMessage,
];

function Surface() {
  const timeline = createMemo(() =>
    groupConversationActivities(conversationTimeline([], messages)),
  );
  return (
    <main class="factory-desktop agent-is-open" data-background="river-landscape">
      <aside class="agent-panel" aria-label="Coding conversation">
        <div class="agent-messages conversation-history" role="log" aria-label="Conversation">
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
                          stopped={stopped}
                          onNavigate={() => {}}
                        />
                      )}
                    </Show>
                  }
                >
                  {(value) => (
                    <ChangeAgentActivityGroup
                      messages={value()}
                      stopped={stopped}
                      onNavigate={() => {}}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </aside>
    </main>
  );
}

render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
