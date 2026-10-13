import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  type SetupInspectionView,
  setupInspectionView,
} from "../../../../packages/project-domain/src/setup";
import { apiRequest } from "../api-client";

export function SetupInspection(props: { projectID: string; storageKey: string }) {
  const [value, setValue] = createSignal<SetupInspectionView | null>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let command: { id: string; parentID?: string; answers?: Record<string, string> } | undefined;
  let questionID: string | undefined;
  const path = () => `/api/projects/${props.projectID}/setup/inspection`;
  function receive(next: SetupInspectionView | null) {
    setValue(next);
    if (questionID === next?.id) return;
    questionID = next?.id;
    let retained: Record<string, string> = {};
    try {
      const saved = z
        .object({ id: z.uuid(), answers: z.record(z.string().max(40), z.string().max(2000)) })
        .parse(JSON.parse(sessionStorage.getItem(props.storageKey) ?? "null"));
      if (saved.id === next?.id) retained = saved.answers;
    } catch {
      /* Optional local draft. */
    }
    setAnswers(retained);
  }
  function answer(id: string, text: string) {
    const next = { ...answers(), [id]: text };
    setAnswers(next);
    try {
      sessionStorage.setItem(props.storageKey, JSON.stringify({ id: questionID, answers: next }));
    } catch {
      /* The current panel remains editable. */
    }
  }
  async function load() {
    const projectID = props.projectID;
    try {
      const next = await apiRequest(setupInspectionView.nullable(), path());
      if (disposed || props.projectID !== projectID) return;
      receive(next);
      if (next?.state === "inspecting") timer = setTimeout(() => void load(), 1500);
    } catch {
      if (!disposed) setError("Project inspection is unavailable. Source is unchanged.");
    }
  }
  createEffect(
    () => props.projectID,
    () => {
      void load();
    },
  );
  onCleanup(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  async function act(operation: "inspect" | "confirm" | "stop" = "inspect") {
    if (busy()) return;
    const projectID = props.projectID;
    setBusy(true);
    setError("");
    const current = value();
    command =
      command ??
      (operation !== "inspect" && current
        ? { id: current.id }
        : {
            id: crypto.randomUUID(),
            ...(current?.output?.questions.length
              ? { parentID: current.id, answers: answers() }
              : {}),
          });
    try {
      const next = await apiRequest(
        setupInspectionView,
        path() + (operation !== "inspect" ? `/${operation}` : ""),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      if (disposed || props.projectID !== projectID) return;
      receive(next);
      command = undefined;
      if (next.state === "inspecting") void load();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Setup is unavailable.");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  return (
    <section class="setup-inspection" aria-label="Project configuration">
      <Show when={value()?.state !== "complete" && value()?.state !== "confirmed"}>
        <Show when={value()?.state === "inspecting"}>
          <p role="status">Understanding your application…</p>
          <button
            type="button"
            class="quiet-button"
            disabled={busy()}
            onClick={() => void act("stop")}
          >
            Stop inspection
          </button>
        </Show>
        <Show when={value()?.state !== "superseded" && value()?.output}>
          {(output) => (
            <>
              <p>{output().purpose}</p>
              <ul>
                <For each={output().services}>
                  {(service) => (
                    <li>
                      <strong>{service.name}</strong> {service.description}
                      <Show when={service.port}> · port {service.port}</Show>
                    </li>
                  )}
                </For>
              </ul>
              <For each={output().uncertainty}>{(note) => <p class="setup-note">{note}</p>}</For>
              <Show when={output().questions.length}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act();
                  }}
                >
                  <For each={output().questions}>
                    {(question) => (
                      <label>
                        {question.question}
                        <textarea
                          required
                          maxlength={2000}
                          value={answers()[question.id] ?? ""}
                          onInput={(event) => answer(question.id, event.currentTarget.value)}
                        />
                      </label>
                    )}
                  </For>
                  <button type="submit" class="primary-button" disabled={busy()}>
                    {busy() ? "Understanding…" : "Continue setup"}
                  </button>
                </form>
              </Show>
              <Show when={output().files.length && !output().questions.length}>
                <p>
                  Only these missing configuration files will be added. Application code stays
                  unchanged.
                </p>
                <details>
                  <summary>Configuration files</summary>
                  <For each={output().files}>
                    {(file) => (
                      <details>
                        <summary>{file.path}</summary>
                        <pre>{file.content}</pre>
                      </details>
                    )}
                  </For>
                </details>
                <button
                  type="button"
                  class="primary-button"
                  disabled={busy()}
                  onClick={() => void act("confirm")}
                >
                  {busy()
                    ? "Applying configuration…"
                    : value()?.state === "confirming"
                      ? "Check confirmed setup"
                      : "Confirm setup"}
                </button>
              </Show>
            </>
          )}
        </Show>
        <Show when={value()?.state === "proposal"}>
          <button
            type="button"
            class="quiet-button"
            disabled={busy()}
            onClick={() => void act("stop")}
          >
            Discard proposal
          </button>
        </Show>
        <Show
          when={value() === null || value()?.state === "failed" || value()?.state === "superseded"}
        >
          <button type="button" class="primary-button" disabled={busy()} onClick={() => void act()}>
            {busy() ? "Inspecting…" : "Inspect project setup"}
          </button>
        </Show>
        <Show when={value()?.failure}>
          <p class="setup-note">{value()?.failure}</p>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
