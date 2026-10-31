import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { APIRequestError } from "../../apps/factory/src/api-client";
import {
  type KnowledgeGeneration,
  type KnowledgePage,
  knowledgeSaveSchema,
  ticketDocumentSaveSchema,
} from "../../apps/factory/src/api-contracts";
import { attachmentText, readAttachmentContent } from "../../apps/factory/src/attachments/composer";
import { AttachmentProvider, TextareaAttachments } from "../../apps/factory/src/attachments/ui";
import { Icon } from "../../apps/factory/src/icon";
import { KnowledgeWorkspace } from "../../apps/factory/src/knowledge-workspace";
import { MarkdownEditor } from "../../apps/factory/src/markdown-editor";
import { MarkdownReader } from "../../apps/factory/src/markdown-reader";
import { ChatSkillPicker } from "../../apps/factory/src/skills/chat-picker";
import {
  type TicketDraft,
  TicketWorkspace,
  type TicketWorkspaceProps,
} from "../../apps/factory/src/ticket-workspace";
import { CopyButton } from "../../apps/factory/src/ui/feedback";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/knowledge-workspace.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import { fixtureValue } from "./value";

const projectID = "10000000-0000-4000-8000-000000000001";
const userID = "10000000-0000-4000-8000-000000000002";
const code = "```ts\nconst ready = true;\n```\n";
const surface = new URLSearchParams(location.search).get("surface") ?? "copy";
const noAction = () => {};

function Wiki() {
  const drafts = new Map();
  const query = new URLSearchParams(location.search);
  const failed = query.has("failed");
  const [loadStage, setLoadStage] = createSignal(
    query.has("empty") ? "empty" : query.has("loading") ? "outline" : "ready",
  );
  const [generationRequests, setGenerationRequests] = createSignal(0);
  const [generation, setGeneration] = createSignal<KnowledgeGeneration | undefined>(
    failed
      ? {
          id: "10000000-0000-4000-8000-000000000003",
          sourceCommitSha: "a".repeat(40),
          state: "failed",
          pageCount: 0,
          conflictCount: 0,
          failure: "The Wiki plan did not cover essential reader guidance.",
        }
      : undefined,
  );
  const [selected, setSelected] = createSignal(0);
  const [pages, setPages] = createSignal<KnowledgePage[]>(
    ["First reference", "Second reference"].map((title, index) => ({
      id: `10000000-0000-4000-8000-00000000001${index}`,
      projectId: projectID,
      slug: `reference-${index}`,
      title,
      currentBody: "A retained reference.",
      state: "active",
      version: 1,
      parentId: null,
      sortOrder: index,
      icon: "knowledge",
      metadataVersion: 1,
      currentRevisionId: null,
    })),
  );
  return (
    <>
      <Show when={failed}>
        <output aria-label="Wiki generation requests">{generationRequests()}</output>
      </Show>
      <Show when={new URLSearchParams(location.search).has("loading")}>
        <nav aria-label="Owned Wiki loading fixture">
          <button type="button" onClick={() => setLoadStage("page")}>
            Receive Wiki outline
          </button>
          <button type="button" onClick={() => setLoadStage("ready")}>
            Receive Wiki body
          </button>
          <button type="button" onClick={() => setLoadStage("unselected")}>
            Clear Wiki selection
          </button>
          <button type="button" onClick={() => setLoadStage("empty")}>
            Receive empty Wiki
          </button>
        </nav>
      </Show>
      <KnowledgeWorkspace
        loading={["outline", "page"].includes(loadStage())}
        pages={["outline", "empty"].includes(loadStage()) ? [] : pages()}
        selectedPage={loadStage() === "ready" ? pages()[selected()] : undefined}
        documents={[]}
        revisions={[]}
        searchResults={[]}
        searchQuery=""
        generation={generation()}
        pending={generation()?.state === "pending"}
        projectID={projectID}
        userID={userID}
        repositoryURL="https://example.invalid/owned-feedback.git"
        canDevelop={false}
        drafts={drafts}
        onSelectPage={(id) => setSelected(pages().findIndex((page) => page.id === id))}
        onOpenDocument={noAction}
        onGenerate={() => {
          setGenerationRequests((previous) => previous + 1);
          setGeneration({
            id: "10000000-0000-4000-8000-000000000004",
            sourceCommitSha: "a".repeat(40),
            state: "pending",
            pageCount: 0,
            conflictCount: 0,
            failure: null,
          });
        }}
        onSearch={noAction}
        onSavePage={async (id, expectedVersion, title, body) => {
          // Synthetic component callback, not a Factory command transport.
          const response = await fetch("/fixture/wiki-save", {
            method: "POST",
            body: JSON.stringify({ id, expectedVersion, title, body }),
          });
          const value: unknown = await response.json();
          if (!response.ok)
            throw new APIRequestError(
              response.status,
              value &&
                typeof value === "object" &&
                "error" in value &&
                typeof value.error === "string"
                ? value.error
                : "Fixture save failed",
            );
          const saved = knowledgeSaveSchema.parse(value);
          setPages((previous) =>
            previous.map((page) =>
              page.id === id
                ? { ...page, version: saved.version, title: saved.title, currentBody: saved.body }
                : page,
            ),
          );
          return saved;
        }}
        onHistory={async () => {}}
        onSources={async () => []}
        onArchive={noAction}
        onMove={async () => {}}
        onIcon={async () => {}}
        onOpenIDE={noAction}
        onRestore={async () => {
          throw new Error("History is outside this owned feedback fixture.");
        }}
      />
    </>
  );
}

function Ticket() {
  const [selected, setSelected] = createSignal(0);
  const [tickets, setTickets] = createSignal(
    ["First Ticket", "Second Ticket"].map((title, index) => ({
      id: `10000000-0000-4000-8000-00000000002${index}`,
      title,
      description: "A retained request.",
      state: "inbox" as const,
      version: 1,
    })),
  );
  const drafts = new Map<string, TicketDraft>();
  const save: TicketWorkspaceProps["onSaveDocument"] = async (input) => {
    const ticketID = fixtureValue(tickets()[selected()], "tickets()[selected()]").id;
    const saved = await fetch("/fixture/ticket-save", {
      method: "POST",
      body: JSON.stringify({ ...input, ticketID }),
    })
      .then(async (response) =>
        response.ok ? ticketDocumentSaveSchema.parse(await response.json()) : undefined,
      )
      .catch(() => undefined);
    if (saved)
      setTickets((previous) =>
        previous.map((ticket) =>
          ticket.id === ticketID
            ? {
                ...ticket,
                title: input.title,
                description: input.description,
                version: saved.ticketVersion,
              }
            : ticket,
        ),
      );
    return saved;
  };
  return (
    <>
      <button class="quiet-button" type="button" onClick={() => setSelected((value) => 1 - value)}>
        Switch Ticket
      </button>
      <TicketWorkspace
        current={{
          ticket: fixtureValue(tickets()[selected()], "tickets()[selected()]"),
          revisions: [],
          documentRevisions: [],
          origin: null,
          followUps: [],
        }}
        storageKey={`feedback-proof:${fixtureValue(tickets()[selected()], "tickets()[selected()]").id}`}
        ticketReference="TCK-1"
        pending={false}
        epics={[]}
        drafts={drafts}
        dependencies={{
          prerequisites: [],
          candidates: [],
          admitted: false,
          pending: false,
          onOpen: noAction,
          onAdd: async () => false,
          onRemove: noAction,
        }}
        onAssignEpic={noAction}
        onInterview={noAction}
        onWriteRequirements={noAction}
        onSaveDocument={save}
        onConfirmRequirements={save}
        clarificationAction={{ label: "Ask AI to clarify", status: false }}
        onFollowUp={noAction}
        onOpenTicket={noAction}
        onOpenEpic={noAction}
        onTrash={noAction}
        onRestore={noAction}
        onImplement={noAction}
        onCodingOptions={noAction}
        codingOptionsOpen={false}
        implementationAvailable={false}
        onStopImplementation={noAction}
        onOpenIDE={noAction}
        onApproveDelivery={noAction}
        canDevelop={false}
        userID={userID}
      />
    </>
  );
}

function Files() {
  const feedback = new URLSearchParams(location.search).get("attachments") === "feedback";
  const [owner, setOwner] = createSignal(0);
  const [body, setBody] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal("");
  return (
    <AttachmentProvider projectId={projectID}>
      <button
        class="quiet-button"
        type="button"
        onClick={() => {
          setOwner((value) => 1 - value);
          setBody("");
        }}
      >
        Switch file draft
      </button>
      <Show when={sendError()}>
        <p role="alert">{sendError()}</p>
      </Show>
      <form
        class={feedback ? "visual-review review-composer" : "agent-composer conversation-composer"}
        style={feedback ? "max-width: 320px;" : undefined}
        onSubmit={async (event) => {
          event.preventDefault();
          setSending(true);
          try {
            const response = await fetch("/fixture/message", { method: "POST", body: body() });
            if (!response.ok) throw new Error("Send unconfirmed. Your draft is retained.");
          } catch (cause) {
            setSendError(cause instanceof Error ? cause.message : "Send failed.");
          } finally {
            setSending(false);
          }
        }}
      >
        <TextareaAttachments
          scopeKey={`feedback:${owner()}`}
          content={body()}
          disabled={sending()}
          privacy={feedback ? "feedback" : "send"}
        >
          <label>
            Message with references
            <textarea
              value={attachmentText(body())}
              disabled={sending()}
              onInput={(event) => setBody(readAttachmentContent(event.currentTarget))}
            />
          </label>
        </TextareaAttachments>
        <div class={feedback ? undefined : "agent-compose-toolbar"}>
          <Show when={!feedback}>
            <ChatSkillPicker
              projectID={projectID}
              workType="planning"
              scope={`feedback:${owner()}`}
              disabled={sending()}
            />
          </Show>
          <button
            class={feedback ? "primary-button" : "agent-control primary"}
            type="submit"
            aria-label="Send message"
          >
            <Show when={feedback} fallback={<Icon name="send" />}>
              Send message
            </Show>
          </button>
        </div>
      </form>
    </AttachmentProvider>
  );
}

function Copy() {
  const [owner, setOwner] = createSignal(0);
  const [mounted, setMounted] = createSignal(true);
  return (
    <>
      <nav>
        <button class="quiet-button" type="button" onClick={() => setOwner((value) => value + 1)}>
          Switch copy context
        </button>
        <button class="quiet-button" type="button" onClick={() => setMounted((value) => !value)}>
          Toggle copy controls
        </button>
      </nav>
      <Show when={mounted()}>
        <section aria-label="Linked workspace">
          <h2>Document link</h2>
          <WorkspaceTabbar
            tabs={[{ id: "reference", view: "knowledge", label: "Reference" }]}
            activeTabID="reference"
            shareURL={`${location.origin}/projects/${projectID}/wiki/reference-${owner()}`}
            onActivate={noAction}
            onClose={noAction}
            onMinimize={noAction}
          />
        </section>
        <section aria-label="Reusable copy button">
          <h2>Copy a reference</h2>
          <CopyButton class="quiet-button" value="Factory reference" scope={owner()} />
          <button class="quiet-button" type="button">
            Next action
          </button>
        </section>
        <section aria-label="Read-only code">
          <h2>Read code</h2>
          <MarkdownReader
            value={`${code}\n${code}`}
            label="Reference code"
            class="markdown-body"
            scopeKey={String(owner())}
          />
        </section>
        <section aria-label="Editable code">
          <h2>Edit code</h2>
          <MarkdownEditor value={code} onChange={noAction} />
        </section>
      </Show>
    </>
  );
}

function Surface() {
  return (
    <main
      class="feedback-proof"
      style="max-width: 960px; margin: 24px auto; padding: 16px; background: var(--color-paper); border-radius: var(--radius-md);"
    >
      <h1>Factory interaction feedback</h1>
      <Show when={surface === "wiki"}>
        <Wiki />
      </Show>
      <Show when={surface === "ticket"}>
        <Ticket />
      </Show>
      <Show when={surface === "files"}>
        <Files />
      </Show>
      <Show when={surface === "copy"}>
        <Copy />
      </Show>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
