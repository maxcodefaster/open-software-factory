import { createSignal, For, Show } from "solid-js";
import { render } from "@solidjs/web";
import { AttachmentProvider, TextareaAttachments } from "../../apps/factory/src/attachments/ui";
import { attachmentText, readAttachmentContent } from "../../apps/factory/src/attachments/composer";
import { MarkdownEditor } from "../../apps/factory/src/markdown-editor";
import { markdownHTML } from "../../apps/factory/src/markdown";
import {
  TicketDraftWorkspace,
  readPersonalTicketDraft,
} from "../../apps/factory/src/ticket-draft-workspace";
import { ReviewPanel, type ReviewActions } from "../../apps/factory/src/review/panel";
import { ConversationEntryCard } from "../../apps/factory/src/conversation-components";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/review/review.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

const query = new URLSearchParams(location.search);
const projectId = query.get("project")!;
const changeID = query.get("change")!;
const userID = query.get("user")!;
const draftId = query.get("draft")!;

function Surface() {
  const [mode, setMode] = createSignal("Wiki");
  const [body, setBody] = createSignal("## Reference\n\nAdd the design and supporting document.");
  const [version, setVersion] = createSignal(1);
  const [saved, setSaved] = createSignal("");
  const [error, setError] = createSignal("");
  const [chat, setChat] = createSignal("");
  const [ticketChat, setTicketChat] = createSignal(false);
  const chatDrafts = new Map<boolean, string>();
  const [messages, setMessages] = createSignal<string[]>([]);
  const [interviewAnswer, setInterviewAnswer] = createSignal("");
  const [actions, setActions] = createSignal<ReviewActions>();
  const key = `attachment-proof-draft:${draftId}`;
  const draft = { ...readPersonalTicketDraft(key), id: draftId };
  async function request(path: string, input?: unknown) {
    const response = await fetch(
      path,
      input === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  void request("/fixture/wiki").then((value) => {
    setBody(value.body);
    setVersion(value.version);
  });
  return (
    <AttachmentProvider projectId={projectId} scopeKey={`${mode()}:${ticketChat()}`}>
      <main style="max-width: 900px; margin: 24px auto; padding: 16px; background: var(--surface-raised);">
        <h1>Attachment proof</h1>
        <p>Scripted fixture using the Factory editors, private storage and feedback controls.</p>
        <nav aria-label="Proof surfaces">
          <For each={["Wiki", "Ticket draft", "Chat", "Interview", "Feedback"]}>
            {(name) => (
              <button type="button" class="quiet-button" onClick={() => setMode(name)}>
                {name}
              </button>
            )}
          </For>
        </nav>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={mode() === "Wiki"}>
          <section aria-label="Wiki attachment editor">
            <MarkdownEditor attachmentScopeKey="wiki" value={body()} onChange={setBody} />
            <button
              type="button"
              onClick={() =>
                void request("/fixture/wiki", { body: body(), expectedVersion: version() })
                  .then((value) => {
                    setVersion(value.version);
                    setSaved(body());
                  })
                  .catch((cause) => setError(cause.message))
              }
            >
              Save Wiki
            </button>
            <Show when={saved()}>
              <article
                aria-label="Saved Wiki"
                class="markdown-body"
                innerHTML={markdownHTML(saved())}
              />
            </Show>
          </section>
        </Show>
        <Show when={mode() === "Ticket draft"}>
          <TicketDraftWorkspace
            storageKey={key}
            initial={draft}
            pending={false}
            onChange={() => {}}
            onCreate={async (value) => {
              await request("/fixture/ticket", value);
              setSaved("Created Ticket");
              return true;
            }}
          />
          <Show when={saved() === "Created Ticket"}>
            <p role="status">Created Ticket</p>
          </Show>
        </Show>
        <Show when={mode() === "Chat"}>
          <section aria-label="Chat attachments">
            <label>
              <input
                type="checkbox"
                checked={ticketChat()}
                onChange={(event) => {
                  chatDrafts.set(ticketChat(), chat());
                  const ticket = event.currentTarget.checked;
                  setTicketChat(ticket);
                  setChat(chatDrafts.get(ticket) ?? "");
                }}
              />
              Share in Ticket chat
            </label>
            <form
              class="agent-composer conversation-composer"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                void request("/fixture/chat", { body: chat(), ticket: ticketChat() })
                  .then(() => {
                    setMessages((previous) => [...previous, chat()]);
                    setChat("");
                    form.reset();
                  })
                  .catch((cause) => setError(cause.message));
              }}
            >
              <TextareaAttachments
                scopeKey={`chat:${ticketChat()}`}
                content={chat()}
                privacy={ticketChat() ? "send" : "personal"}
              >
                <textarea
                  aria-label="Chat message"
                  value={attachmentText(chat())}
                  onInput={(event) => setChat(readAttachmentContent(event.currentTarget))}
                />
              </TextareaAttachments>
              <button type="submit">Send message</button>
            </form>
            <For each={messages()}>
              {(message) => <article class="markdown-body" innerHTML={markdownHTML(message)} />}
            </For>
          </section>
        </Show>
        <Show when={mode() === "Interview"}>
          <section aria-label="Interview attachments">
            <ConversationEntryCard
              entry={{
                id: "attachment-proof-question",
                ordinal: 1,
                kind: "question",
                actor: "project-agent",
                mode: "plan",
                body: "Which reference should the implementation follow?",
                payload: {
                  question: {
                    type: "free-text",
                    prompt: "Which reference should the implementation follow?",
                    placeholder: "Explain the reference",
                  },
                },
                citations: [],
                inReplyToEntryId: null,
                requirementRevisionId: null,
                createdAt: new Date().toISOString(),
              }}
              answered={!!interviewAnswer()}
              answerSummary={interviewAnswer() || undefined}
              requirementApproved={false}
              requirementCurrent={false}
              canAnswer={true}
              pending={false}
              initialAnswer={undefined}
              answerStorageKey={`attachment-proof-answer:${draftId}`}
              onAnswer={(event) => {
                event.preventDefault();
                const body = readAttachmentContent(
                  (event.currentTarget as HTMLFormElement).querySelector("textarea")!,
                );
                void request("/fixture/chat", { body, ticket: true })
                  .then(() => setInterviewAnswer(body))
                  .catch((cause) => setError(cause.message));
              }}
              onPause={() => {}}
              onResume={() => {}}
              requirementVisible={false}
              onReviewRequirements={() => {}}
              onCitation={() => {}}
            />
          </section>
        </Show>
        <Show when={mode() === "Feedback"}>
          <button type="button" onClick={() => actions()?.addFeedback?.()}>
            New feedback
          </button>
          <ReviewPanel
            changeID={changeID}
            userID={userID}
            canDevelop={true}
            onActions={setActions}
          />
        </Show>
      </main>
    </AttachmentProvider>
  );
}
render(() => <Surface />, document.getElementById("root")!);
