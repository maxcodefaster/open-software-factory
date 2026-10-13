import { createMemo, createSignal, For, Show } from "solid-js";
import {
  type InterviewAnswer,
  type InterviewQuestion,
  interviewQuestionInput,
  interviewAnswerInput,
} from "../../../packages/conversation-domain/src/conversation";
import type { RequirementContent } from "../../../packages/requirement-domain/src/content";
import type { AgentMessage, ConversationEntry } from "./api-contracts";
import { markdownHTML } from "./markdown";
import { composerKeyDown, resizeComposer } from "./assistant-interaction";

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
  const [selected, setSelected] = createSignal<string[]>(restored?.selectedOptionIds ?? []);
  const [customEnabled, setCustomEnabled] = createSignal(
    question.type === "free-text" || !!restored?.customText,
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
          <For each={choiceQuestion?.options ?? []}>
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
                {question.type === "single-select" ? "Something else" : "Add another answer"}
              </span>
            </label>
          </Show>
        </fieldset>
      </Show>
      <Show when={customEnabled()}>
        <textarea
          rows={1}
          onKeyDown={composerKeyDown}
          name="custom"
          aria-label="Custom answer"
          placeholder={question.type === "free-text" ? question.placeholder : "Write your answer"}
          value={customText()}
          onInput={(event) => {
            const text = event.currentTarget.value;
            setCustomText(text);
            resizeComposer(event.currentTarget);
            retain({ selectedOptionIds: selected(), customText: text });
          }}
        />
      </Show>
      <button type="submit" class="agent-control primary" disabled={props.pending || !valid()}>
        Continue
      </button>
      <button type="button" class="quiet-button" onClick={props.onPause}>
        Pause clarification
      </button>
    </form>
  );
}

export function ChangeAgentMessage(props: { message: AgentMessage }) {
  return (
    <Show
      when={props.message.activity}
      fallback={
        <article class={`agent-message ${props.message.role}`}>
          <small class="sr-only">{props.message.role === "user" ? "You" : "Assistant"}</small>
          <div class="markdown-body" innerHTML={markdownHTML(props.message.text)} />
        </article>
      }
    >
      {(activity) => (
        <article class={`agent-activity ${activity().status}`}>
          <div class="agent-activity-heading">
            <span class="activity-indicator" />
            <div>
              <small>{activity().name}</small>
              <strong>{props.message.text}</strong>
            </div>
            <span class="activity-status">{activity().status}</span>
          </div>
          <Show when={activity().detail}>
            {(detail) => (
              <details>
                <summary>Output</summary>
                <pre>{detail()}</pre>
              </details>
            )}
          </Show>
        </article>
      )}
    </Show>
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
            <div class="markdown-body" innerHTML={markdownHTML(props.answerSummary ?? "")} />
          </details>
        }
      >
        <article class="conversation-question">
          <Show when={String(entry.payload["message"] ?? "")}>
            <p>{String(entry.payload["message"] ?? "")}</p>
          </Show>
          <strong>{entry.body}</strong>
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
      <article class="conversation-requirement">
        <p>{entry.body}</p>
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
    <article class={`agent-message ${entry.actor === "user" ? "user" : "assistant"}`}>
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
