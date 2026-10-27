import { createMemo, createSignal, For, Show } from "solid-js";
import {
  type InterviewAnswer,
  type InterviewQuestion,
  interviewQuestionInput,
  interviewAnswerInput,
} from "../../../packages/conversation-domain/src/conversation";
import type { AgentMessage, ConversationEntry } from "./api-contracts";
import { markdownHTML } from "./markdown";
import { composerKeyDown, resizeComposer } from "./assistant-interaction";
import { interviewOptions } from "./interview-options";
import { TextareaAttachments } from "./attachments/ui";
import { attachmentText, readAttachmentContent } from "./attachments/composer";
import { CopyButton } from "./ui/feedback";
import { Icon } from "./icon";
import { activeActivity, activityGroupSummary } from "./conversation-activity";

function MessageCopy(props: { text: string; scope: string; user?: boolean }) {
  return (
    <div class="agent-message-actions">
      <CopyButton
        class="quiet-button"
        value={props.text}
        scope={props.scope}
        accessibleLabel={props.user ? "Copy user message" : "Copy Assistant message"}
      />
    </div>
  );
}
export function conversationQuestion(entry: ConversationEntry): InterviewQuestion | undefined {
  const parsed = interviewQuestionInput.safeParse(entry.payload["question"]);
  return parsed.success ? parsed.data : undefined;
}

function InterviewAnswerForm(props: {
  question: InterviewQuestion;
  pending: boolean;
  initialAnswer: InterviewAnswer | undefined;
  storageKey: string;
  onSubmit(event: SubmitEvent): void;
  onPause(): void;
}) {
  const question = props.question;
  let restored = props.initialAnswer;
  try {
    restored = interviewAnswerInput.parse(
      JSON.parse(localStorage.getItem(props.storageKey) ?? "null"),
    );
  } catch {
    /* Use admitted pending answer or an empty form. */
  }
  const choiceQuestion = question.type === "free-text" ? undefined : question;
  const choices = interviewOptions(question);
  const restoredCustom = restored?.selectedOptionIds.some((id) =>
    choices.customOptionIds.includes(id),
  );
  const [selected, setSelected] = createSignal<string[]>(
    restored?.selectedOptionIds.filter((id) => !choices.customOptionIds.includes(id)) ?? [],
  );
  const [customEnabled, setCustomEnabled] = createSignal(
    question.type === "free-text" || !!restored?.customText || !!restoredCustom,
  );
  const [customText, setCustomText] = createSignal(restored?.customText ?? "");
  function retain(answer: InterviewAnswer) {
    try {
      localStorage.setItem(props.storageKey, JSON.stringify(answer));
    } catch {
      /* The visible form still retains input. */
    }
  }
  const valid = () => selected().length > 0 || (customEnabled() && !!customText().trim());
  function choose(id: string, checked: boolean) {
    const ids =
      question.type === "single-select"
        ? [id]
        : checked
          ? [...selected(), id]
          : selected().filter((value) => value !== id);
    setSelected(ids);
    if (question.type === "single-select") {
      setCustomEnabled(false);
    }
    retain({
      selectedOptionIds: ids,
      customText: question.type !== "single-select" && customEnabled() ? customText() : "",
    });
  }
  return (
    <form onSubmit={props.onSubmit}>
      <Show when={choiceQuestion}>
        <fieldset class="interview-options" aria-label="Answer options">
          <For each={choices.options}>
            {(option) => (
              <label>
                <input
                  type={question.type === "multi-select" ? "checkbox" : "radio"}
                  name="option"
                  value={option.id}
                  checked={selected().includes(option.id)}
                  onChange={(event) => choose(option.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <Show when={option.description}>
                    <small>{option.description}</small>
                  </Show>
                </span>
              </label>
            )}
          </For>
          <Show when={choiceQuestion?.allowCustom}>
            <label>
              <input
                type={question.type === "multi-select" ? "checkbox" : "radio"}
                name={question.type === "single-select" ? "option" : "custom-choice"}
                value=""
                checked={customEnabled()}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  setCustomEnabled(enabled);
                  if (question.type === "single-select") setSelected([]);
                  retain({
                    selectedOptionIds: question.type === "single-select" ? [] : selected(),
                    customText: enabled ? customText() : "",
                  });
                }}
              />
              <span>
                <strong>
                  {question.type === "single-select" ? "Something else" : "Add another answer"}
                </strong>
                <Show when={choices.customDescription}>
                  <small>{choices.customDescription}</small>
                </Show>
              </span>
            </label>
          </Show>
        </fieldset>
      </Show>
      <Show when={customEnabled()}>
        <TextareaAttachments
          disabled={props.pending}
          scopeKey={props.storageKey}
          content={customText()}
        >
          <textarea
            rows={1}
            onKeyDown={composerKeyDown}
            name="custom"
            aria-label="Custom answer"
            placeholder={question.type === "free-text" ? question.placeholder : "Write your answer"}
            value={attachmentText(customText())}
            onInput={(event) => {
              const text = readAttachmentContent(event.currentTarget);
              setCustomText(text);
              resizeComposer(event.currentTarget);
              retain({ selectedOptionIds: selected(), customText: text });
            }}
          />
        </TextareaAttachments>
      </Show>
      <div class="interview-answer-actions">
        <button type="button" class="quiet-button" onClick={props.onPause}>
          Pause clarification
        </button>
        <button type="submit" class="agent-control primary" disabled={props.pending || !valid()}>
          Continue
        </button>
      </div>
    </form>
  );
}

export function ChangeAgentMessage(props: {
  message: AgentMessage;
  onActivityToggle?: (open: boolean) => void;
  onNavigate?: ((message: AgentMessage, kind: "file" | "diff") => void) | undefined;
}) {
  return (
    <Show
      when={props.message.activity}
      fallback={
        <article
          class={`agent-message ${props.message.role}`}
          id={`coding-message-${props.message.id}`}
          tabindex="-1"
        >
          <small class="sr-only">{props.message.role === "user" ? "You" : "Assistant"}</small>
          <div class="markdown-body" innerHTML={markdownHTML(props.message.text)} />
          <Show when={props.message.truncated}>
            <p class="activity-truncation">
              Shortened message preview. Copy includes only the shown text.
            </p>
          </Show>
          <Show when={props.message.role !== "tool"}>
            <MessageCopy
              text={props.message.text}
              scope={props.message.id}
              user={props.message.role === "user"}
            />
          </Show>
        </article>
      }
    >
      {(activity) => (
        <details
          class={`agent-activity ${activity().status}`}
          onToggle={(event) => props.onActivityToggle?.(event.currentTarget.open)}
        >
          <summary class="agent-activity-heading">
            <Icon name="chevron" />
            <span class="activity-name sr-only">{activity().name}</span>
            <span class="activity-command" title={props.message.text}>
              {props.message.text}
            </span>
            <span class="activity-status">
              <span class="activity-indicator" aria-hidden="true" />
              {activity().status === "completed"
                ? "Done"
                : activity().status === "error"
                  ? "Failed"
                  : activity().status === "pending"
                    ? "Queued"
                    : "Running"}
            </span>
          </summary>
          <div class="agent-activity-content">
            <Show when={activity().navigation && props.onNavigate}>
              <div class="agent-activity-navigation">
                <button
                  type="button"
                  class="quiet-button"
                  onClick={() => props.onNavigate?.(props.message, "file")}
                >
                  Open file in IDE
                </button>
                <Show when={activity().navigation?.diff}>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => props.onNavigate?.(props.message, "diff")}
                  >
                    Open recorded diff
                  </button>
                </Show>
              </div>
            </Show>
            <pre class="activity-command-full">{props.message.text}</pre>
            <Show when={activity().detail}>
              {(detail) => <pre class="activity-output">{detail()}</pre>}
            </Show>
            <Show when={activity().truncated}>
              <p class="activity-truncation" role="note">
                This is a shortened activity preview, not the complete command or output.
              </p>
            </Show>
          </div>
        </details>
      )}
    </Show>
  );
}

export function ChangeAgentActivityGroup(props: {
  messages: AgentMessage[];
  onNavigate?: ((message: AgentMessage, kind: "file" | "diff") => void) | undefined;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const active = () => props.messages.filter(activeActivity).length;
  const failed = () => props.messages.filter((item) => item.activity?.status === "error").length;
  const contentID = () =>
    `activity-group-${props.messages[0]?.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <section class="agent-activity-group" aria-label="Grouped tool activity">
      <Show when={props.messages.length > 1}>
        <button
          type="button"
          class="activity-group-toggle"
          aria-expanded={expanded() ? "true" : "false"}
          aria-controls={contentID()}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="chevron" />
          <span class="activity-group-summary" title={activityGroupSummary(props.messages)}>
            {activityGroupSummary(props.messages)}
          </span>
          <span class="activity-group-state">
            {[active() ? `${active()} active` : "", failed() ? `${failed()} failed` : ""]
              .filter(Boolean)
              .join(" · ") || "Completed"}
          </span>
        </button>
      </Show>
      <div id={contentID()} class="activity-group-calls">
        <For each={props.messages} keyed={(message) => message.id}>
          {(message) => (
            <div
              hidden={
                props.messages.length > 1 &&
                !expanded() &&
                !activeActivity(message()) &&
                message().activity?.status !== "error" &&
                !opened().has(message().id)
              }
            >
              <ChangeAgentMessage
                message={message()}
                onNavigate={props.onNavigate}
                onActivityToggle={(open) =>
                  setOpened((previous) => {
                    const next = new Set(previous);
                    if (open) next.add(message().id);
                    else next.delete(message().id);
                    return next;
                  })
                }
              />
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

export function ConversationEntryCard(props: {
  entry: ConversationEntry;
  answered: boolean;
  answerSummary: string | undefined;
  requirementApproved: boolean;
  requirementCurrent: boolean;
  canAnswer: boolean;
  pending: boolean;
  initialAnswer: InterviewAnswer | undefined;
  answerStorageKey: string;
  onAnswer(event: SubmitEvent, question: InterviewQuestion): void;
  onPause(): void;
  onResume(): void;
  requirementVisible: boolean;
  onReviewRequirements(): void;
  onCitation(citation: ConversationEntry["citations"][number]): void;
}) {
  const entry = props.entry;
  const question = conversationQuestion(entry);
  if (entry.kind === "question" && question) {
    return (
      <Show
        when={!props.answered}
        fallback={
          <details class="answered-question">
            <summary>
              {(props.answerSummary ?? "Answered").slice(0, 88)}
              {(props.answerSummary?.length ?? 0) > 88 ? "…" : ""}
            </summary>
            <p>{entry.body}</p>
            <MessageCopy text={entry.body} scope={entry.id} />
            <div class="markdown-body" innerHTML={markdownHTML(props.answerSummary ?? "")} />
            <MessageCopy text={props.answerSummary ?? ""} scope={`${entry.id}:answer`} user />
          </details>
        }
      >
        <article class="conversation-question" id={`conversation-entry-${entry.id}`} tabindex="-1">
          <Show when={String(entry.payload["message"] ?? "")}>
            <p>{String(entry.payload["message"] ?? "")}</p>
          </Show>
          <strong>{entry.body}</strong>
          <MessageCopy
            text={[String(entry.payload["message"] ?? ""), entry.body].filter(Boolean).join("\n\n")}
            scope={entry.id}
          />
          <Show when={!props.answered}>
            <Show
              when={props.canAnswer}
              fallback={
                <button type="button" class="quiet-button" onClick={props.onResume}>
                  Continue clarification
                </button>
              }
            >
              <InterviewAnswerForm
                question={question}
                pending={props.pending}
                initialAnswer={props.initialAnswer}
                storageKey={props.answerStorageKey}
                onSubmit={(event) => props.onAnswer(event, question)}
                onPause={props.onPause}
              />
            </Show>
          </Show>
        </article>
      </Show>
    );
  }
  if (entry.kind === "requirement") {
    return (
      <article class="conversation-requirement" id={`conversation-entry-${entry.id}`} tabindex="-1">
        <div class="markdown-body" innerHTML={markdownHTML(entry.body)} />
        <MessageCopy text={entry.body} scope={entry.id} />
        <Show when={entry.payload["epicProposal"] || !props.requirementVisible}>
          <button
            type="button"
            class="quiet-button"
            disabled={props.pending}
            onClick={props.onReviewRequirements}
          >
            {entry.payload["epicProposal"]
              ? "Review proposed work"
              : entry.payload["ticketId"]
                ? "Open ticket"
                : "Review draft"}
          </button>
        </Show>
        <Show when={props.requirementApproved}>
          <span class="approved">Approved</span>
        </Show>
        <Show when={entry.requirementRevisionId && !props.requirementCurrent}>
          <small>Superseded by a newer revision</small>
        </Show>
      </article>
    );
  }
  if (entry.kind === "mode-change") {
    return (
      <article class="conversation-boundary">
        <span>{entry.mode}</span>
        <p>{entry.body}</p>
      </article>
    );
  }
  const rendered = createMemo(() =>
    markdownHTML(
      entry.body,
      false,
      entry.citations.map((citation, index) => ({
        reference: citation.reference ?? index + 1,
        label: citation.label,
      })),
    ),
  );
  return (
    <article
      class={`agent-message ${entry.actor === "user" ? "user" : "assistant"}`}
      id={`conversation-entry-${entry.id}`}
      tabindex="-1"
    >
      <small class="sr-only">
        {entry.kind === "answer" ? "Your answer" : entry.actor === "user" ? "You" : "Assistant"}
      </small>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: The parsed native citation buttons provide keyboard activation; this container only delegates their click events. */}
      <div
        class="markdown-body"
        innerHTML={rendered()}
        onClick={(event) => {
          if (!(event.target instanceof Element)) return;
          const button = event.target.closest<HTMLButtonElement>("button[data-citation]");
          if (!button || !event.currentTarget.contains(button)) return;
          const reference = Number(button.dataset["citation"]);
          const citation = entry.citations.find(
            (value, index) => (value.reference ?? index + 1) === reference,
          );
          if (citation) props.onCitation(citation);
        }}
      />
      <Show when={entry.actor !== "system"}>
        <MessageCopy text={entry.body} scope={entry.id} user={entry.actor === "user"} />
      </Show>
      <Show when={entry.citations.length && !rendered().includes('class="inline-citation"')}>
        <details class="conversation-sources">
          <summary>Sources</summary>
          <For each={entry.citations}>
            {(citation) => (
              <button
                type="button"
                title={citation.label}
                onClick={() => props.onCitation(citation)}
              >
                {citation.label}
              </button>
            )}
          </For>
        </details>
      </Show>
    </article>
  );
}
