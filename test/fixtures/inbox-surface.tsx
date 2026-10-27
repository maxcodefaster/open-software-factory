import { render } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { InboxWorkspace } from "../../apps/factory/src/inbox/workspace";
import {
  initialInboxPosition,
  nextInboxQueueItem,
  type InboxQueue,
} from "../../apps/factory/src/inbox/navigation";
import { InboxSourceNavigation } from "../../apps/factory/src/inbox/source-navigation";
import { TicketPeople } from "../../apps/factory/src/inbox/ticket-people";
import { MentionSupport } from "../../apps/factory/src/inbox/mentions";
import type {
  AttentionPerson,
  InboxItem,
  TicketAttention,
} from "../../apps/factory/src/inbox/contracts";
import { DockButton } from "../../apps/factory/src/dock";
import { ReviewComposer } from "../../apps/factory/src/review/composer";
import { markdownHTML } from "../../apps/factory/src/markdown";
import { revealInboxSource } from "../../apps/factory/src/inbox/client";
import { ConversationEntryCard } from "../../apps/factory/src/conversation-components";
import {
  type InterviewQuestion,
  normalizeInterviewAnswer,
} from "../../packages/conversation-domain/src/conversation";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const query = new URLSearchParams(location.search);
const people: AttentionPerson[] = [
  { id: id(1), name: "Lisa Product", develop: false, manage: false },
  {
    id: id(2),
    name: query.has("long-person")
      ? "Dr. Alexandra-Maria von Beispielhausen, International Product Development"
      : "Tom Development",
    develop: true,
    manage: true,
  },
];

function InterviewFixture() {
  const type = query.get("interview");
  const question: InterviewQuestion =
    type === "single-select" || type === "multi-select"
      ? {
          type,
          prompt: "Who should review the invoice export?",
          options: [
            { id: "product", label: "Product", description: "Checks the intended outcome" },
            { id: "development", label: "Development", description: "Checks the implementation" },
          ],
          allowCustom: true,
        }
      : {
          type: "free-text",
          prompt: "What should remain out of scope?",
          placeholder: "Describe the boundary",
        };
  const [submitted, setSubmitted] = createSignal("");
  return (
    <>
      <ConversationEntryCard
        entry={{
          id: id(200),
          ordinal: 1,
          kind: "question",
          actor: "project-agent",
          mode: "plan",
          body: question.prompt,
          payload: { question },
          citations: [],
          createdAt: "2026-10-26T10:30:00Z",
        }}
        answered={false}
        answerSummary={undefined}
        requirementApproved={false}
        requirementCurrent={false}
        canAnswer
        pending={false}
        initialAnswer={undefined}
        answerStorageKey={`synthetic-interview:${type}`}
        onAnswer={(event, question) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget as HTMLFormElement);
          const answer = normalizeInterviewAnswer(question, {
            selectedOptionIds: form.getAll("option").map(String).filter(Boolean),
            customText: String(form.get("custom") ?? ""),
          });
          setSubmitted(JSON.stringify(answer));
        }}
        onPause={() => {}}
        onResume={() => {}}
        requirementVisible={false}
        onReviewRequirements={() => {}}
        onCitation={() => {}}
      />
      <output aria-label="Submitted Interview answer">{submitted()}</output>
    </>
  );
}
function seed(): InboxItem[] {
  return [
    [
      "Answer the Agent’s question",
      "Should existing customers keep their current invoice numbering?",
      true,
      10,
    ],
    [
      "Review and approve Delivery",
      "Verification and independent review passed for the exact candidate.",
      true,
      20,
    ],
    [
      "You were mentioned in review",
      "Please inspect the empty state before we continue.",
      false,
      20,
    ],
    [
      "New review discussion",
      "Four replies about accessible keyboard navigation are grouped in this discussion.",
      false,
      10,
    ],
    [
      "You are responsible for this Ticket",
      "Lisa assigned you responsibility. Agent execution remains unchanged.",
      false,
      10,
    ],
  ].map(([title, preview, needsAction, project], index) => ({
    id: `synthetic:${index}`,
    eventId: id(index + 100),
    projectId: id(Number(project)),
    projectName: query.has("long-inbox")
      ? "International customer billing and invoice reconciliation"
      : project === 10
        ? "Billing"
        : "Customer portal",
    ticketId: id(index + 30),
    ticketTitle: query.has("long-inbox")
      ? "InvoiceReconciliationWithoutSpaces".repeat(8)
      : index === 3
        ? "Keep keyboard navigation usable with a very long Ticket title on narrow screens"
        : "Improve invoice history",
    title: String(title),
    preview: String(preview),
    needsAction: Boolean(needsAction),
    createdAt: "2026-10-26T10:30:00Z",
    unread: true,
    archived: false,
    updates: index === 3 ? 4 : 1,
    target: (index === 0 ? "conversation" : index < 4 ? "review" : "ticket") as InboxItem["target"],
    targetId: null,
    contextId: null,
  }));
}

function Surface() {
  const many = query.has("many")
    ? seed()
        .filter((item) => !item.needsAction)
        .flatMap((item) =>
          Array.from({ length: 12 }, (_, index) => ({
            ...item,
            id: `${item.id}:extra:${index}`,
            ticketTitle: `Invoice history ${index + 1}`,
          })),
        )
    : [];
  const [items, setItems] = createSignal(
    query.has("empty")
      ? []
      : [...seed().filter((item) => !query.has("requests-only") || item.needsAction), ...many],
  );
  const [position, setPosition] = createSignal(initialInboxPosition());
  const [restoreKey, setRestoreKey] = createSignal(0);
  const [queue, setQueue] = createSignal<InboxQueue>();
  const [error, setError] = createSignal(
    query.has("error") ? "Your Inbox could not be refreshed." : "",
  );
  const [loaded, setLoaded] = createSignal(!query.has("loading"));
  const [source, setSource] = createSignal<InboxItem>();
  const [draft, setDraft] = createSignal("");
  const [submitted, setSubmitted] = createSignal("");
  const [showReview, setShowReview] = createSignal(false);
  const [peopleError, setPeopleError] = createSignal("");
  const [metadata, setMetadata] = createSignal<TicketAttention>({
    responsibleId: query.has("unavailable-person")
      ? id(999)
      : query.has("long-person")
        ? id(2)
        : null,
    version: 0,
    following: false,
    people: query.has("no-people") ? [] : people,
  });
  const count = () =>
    items().filter((item) => item.needsAction || (!item.archived && item.unread)).length;
  const mark = async (item: InboxItem, action: "read" | "unread" | "archive") => {
    if (query.has("write-delay")) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (query.has("write-throw")) throw new Error("Your change was not saved. Try again.");
    if (query.has("write-error")) {
      setError("Your change was not saved. Refresh the Inbox, then repeat the action.");
      return;
    }
    setItems((current) =>
      current.map((value) =>
        value.id === item.id
          ? { ...value, unread: action === "unread", archived: action === "archive" }
          : value,
      ),
    );
  };
  const back = () => {
    setRestoreKey((key) => key + 1);
    setQueue(undefined);
    setSource(undefined);
  };
  const next = () => {
    const current = queue();
    return current ? nextInboxQueueItem(current, items()) : undefined;
  };
  const openSource = async (item: InboxItem, ids?: readonly string[]) => {
    setQueue({
      ids: ids ?? queue()?.ids ?? [item.id],
      current: item,
      section: position().section,
      project: position().project,
    });
    setPosition((current) => ({ ...current, selectedId: item.id }));
    setSource(item);
    await new Promise<void>((resolve) => onSettled(resolve));
    await revealInboxSource("#synthetic-source", new AbortController().signal);
    if (item.unread) await mark(item, "read");
  };
  return (
    <main
      class="factory-desktop"
      data-background="river-landscape"
      aria-label="Synthetic Inbox fixture"
    >
      <MentionSupport
        projectID={id(10)}
        sharedTicket={true}
        loadPeople={async () => {
          if (query.has("mention-error")) throw new Error("Synthetic member read failure");
          return people;
        }}
      />
      <header class="factory-topbar">
        <div class="topbar-start">
          <span class="context-button">Billing · Synthetic fixture</span>
        </div>
        <nav class="workspace-dock" aria-label="Workspace dock">
          <DockButton
            label="Inbox"
            icon="inbox"
            count={query.has("overflow") ? 112 : count()}
            active={true}
            onClick={back}
          />
        </nav>
        <span class="topbar-end">Personal Inbox</span>
      </header>
      <section class="workspace-window workspace-window-inbox" aria-label="Inbox workspace">
        <div class="workspace-view-body">
          <Show when={!query.has("queue-flow") || !source()}>
            <InboxWorkspace
              position={position()}
              restoreKey={restoreKey()}
              onPosition={(patch) => setPosition((current) => ({ ...current, ...patch }))}
              view={loaded() ? { items: items(), count: count() } : undefined}
              loading={!loaded() || query.has("refreshing")}
              busy={query.has("inbox-busy")}
              error={error()}
              onRefresh={() => {
                setError("");
                setLoaded(true);
              }}
              onMark={mark}
              onOpen={(item, ids) => void openSource(item, ids)}
            />
          </Show>
        </div>
      </section>
      <Show when={source()}>
        {(item) => (
          <section
            class="inbox-fixture-source"
            id="synthetic-source"
            tabindex="-1"
            aria-label="Exact Ticket source"
          >
            <InboxSourceNavigation
              next={next()}
              busy={false}
              onBack={back}
              onNext={() => {
                const item = next();
                if (item) void openSource(item);
              }}
            />
            <h2>{item().ticketTitle}</h2>
            <p>{item().preview}</p>
            <TicketPeople
              value={metadata()}
              busy={query.has("people-busy")}
              onAssign={async (responsibleId) => {
                if (query.has("people-error")) {
                  setPeopleError("Your change was not saved. Try again.");
                  return;
                }
                setMetadata((current) => ({
                  ...current,
                  responsibleId,
                  version: current.version + 1,
                }));
              }}
              onFollow={async (following) => setMetadata((current) => ({ ...current, following }))}
            />
            <Show when={peopleError()}>
              <p class="form-error" role="alert">
                {peopleError()}
              </p>
            </Show>
            <Show when={query.has("interview")}>
              <InterviewFixture />
            </Show>
            <button type="button" class="quiet-button" onClick={() => setShowReview(true)}>
              Add feedback
            </button>
            <Show when={showReview()}>
              <ReviewComposer
                attachmentScopeKey="inbox-proof"
                body={draft()}
                kind="comment"
                busy={false}
                locked={false}
                active={true}
                onBody={setDraft}
                onKind={() => {}}
                onSubmit={(event) => {
                  event.preventDefault();
                  setSubmitted(draft());
                }}
                onCancel={() => setShowReview(false)}
                onDismiss={() => setShowReview(false)}
              />
            </Show>
            <output
              aria-label="Saved feedback"
              class="markdown-body"
              innerHTML={markdownHTML(submitted())}
            />
            <button
              type="button"
              class="quiet-button"
              onClick={() => {
                const open = source();
                if (open) setItems((current) => current.filter((value) => value.id !== open.id));
                setSource(undefined);
              }}
            >
              Resolve source request
            </button>
          </section>
        )}
      </Show>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
