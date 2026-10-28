import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  type SetupInspectionView,
  setupFeedbackKey,
} from "../../../../packages/project-domain/src/setup";
import { APIRequestError } from "../api-client";
import { serverCall } from "../server-functions/result";
import {
  confirmSetupInspection,
  getSetupInspection,
  startSetupInspection,
  stopSetupInspection,
} from "../server-functions/setup";

const retainedCommand = z
  .object({
    operation: z.enum(["inspect", "confirm", "stop"]),
    body: z
      .object({
        id: z.uuid(),
        parentID: z.uuid().optional(),
        answers: z.record(z.string().max(40), z.string().max(2000)).optional(),
      })
      .strict(),
  })
  .strict();

export function SetupInspection(props: { projectID: string; storageKey: string }) {
  const [value, setValue] = createSignal<SetupInspectionView | null>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [reading, setReading] = createSignal(false);
  const [readFailed, setReadFailed] = createSignal(false);
  const [pending, setPending] = createSignal<z.infer<typeof retainedCommand>>();
  const [correcting, setCorrecting] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let readVersion = 0;
  let questionID: string | undefined;
  const blocked = () => busy() || Boolean(pending()) || readFailed();
  const commandKey = () => `${props.storageKey}:command`;
  function clearPending() {
    setPending(undefined);
    try {
      sessionStorage.removeItem(commandKey());
    } catch {
      /* Optional recovery storage. */
    }
  }
  function receive(next: SetupInspectionView | null) {
    setValue(next);
    if (questionID === next?.id) return;
    questionID = next?.id;
    setCorrecting(false);
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
    if (busy() || pending()) return;
    const next = { ...answers(), [id]: text };
    setAnswers(next);
    try {
      sessionStorage.setItem(props.storageKey, JSON.stringify({ id: questionID, answers: next }));
    } catch {
      /* The current panel remains editable. */
    }
  }
  async function load(projectID = props.projectID) {
    const version = ++readVersion;
    if (timer) clearTimeout(timer);
    setReading(true);
    try {
      const next = await serverCall(getSetupInspection({ data: [projectID] }));
      if (disposed || props.projectID !== projectID || version !== readVersion) return;
      receive(next);
      setReadFailed(false);
      const command = pending();
      if (
        command &&
        next?.id === command.body.id &&
        (command.operation === "inspect" ||
          (command.operation === "confirm" && ["confirming", "confirmed"].includes(next.state)) ||
          (command.operation === "stop" && next.state === "superseded"))
      )
        clearPending();
      if (!pending()) setError("");
      if (next?.state === "inspecting") timer = setTimeout(() => void load(), 1500);
    } catch {
      if (!disposed && version === readVersion) {
        setReadFailed(true);
        setError("Project inspection is unavailable. Source is unchanged.");
      }
    } finally {
      if (!disposed && version === readVersion) setReading(false);
    }
  }
  createEffect(
    () => ({ projectID: props.projectID, commandKey: commandKey() }),
    ({ projectID, commandKey }) => {
      try {
        const saved = retainedCommand.safeParse(
          JSON.parse(sessionStorage.getItem(commandKey) ?? "null"),
        );
        if (saved.success) setPending(saved.data);
      } catch {
        /* Current work remains available without local recovery storage. */
      }
      void load(projectID);
    },
  );
  onCleanup(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  async function act(operation: "inspect" | "confirm" | "stop" = "inspect") {
    if (busy() || (pending() && pending()?.operation !== operation)) return;
    const projectID = props.projectID;
    setBusy(true);
    setError("");
    if (timer) clearTimeout(timer);
    timer = undefined;
    ++readVersion;
    setReading(false);
    const current = value();
    const command = pending() ?? {
      operation,
      body:
        operation !== "inspect" && current
          ? { id: current.id }
          : {
              id: crypto.randomUUID(),
              ...(current?.state === "proposal" &&
              (current.output?.questions.length || answers()[setupFeedbackKey])
                ? { parentID: current.id, answers: { ...answers() } }
                : current?.state === "failed"
                  ? { parentID: current.id }
                  : {}),
            },
    };
    setPending(command);
    try {
      sessionStorage.setItem(commandKey(), JSON.stringify(command));
    } catch {
      /* Retain in memory. */
    }
    try {
      const next = await serverCall(
        operation === "inspect"
          ? startSetupInspection({ data: [projectID, command.body] })
          : operation === "confirm"
            ? confirmSetupInspection({ data: [projectID, command.body.id] })
            : stopSetupInspection({ data: [projectID, command.body.id] }),
      );
      if (disposed || props.projectID !== projectID) return;
      ++readVersion;
      setReading(false);
      receive(next);
      clearPending();
      setReadFailed(false);
      if (next.state === "inspecting") void load();
    } catch (cause) {
      if (!disposed) {
        // A rejected command can be corrected after re-reading authoritative
        // state. Lost responses and 5xx outcomes retain the immutable command.
        if (cause instanceof APIRequestError && cause.status >= 400 && cause.status < 500) {
          clearPending();
          await load();
        }
        setError(cause instanceof Error ? cause.message : "Setup is unavailable.");
      }
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
            disabled={blocked()}
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
                          disabled={blocked()}
                          value={answers()[question.id] ?? ""}
                          onInput={(event) => answer(question.id, event.currentTarget.value)}
                        />
                      </label>
                    )}
                  </For>
                  <button type="submit" class="primary-button" disabled={blocked()}>
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
                <Show when={value()?.state === "proposal"}>
                  <button
                    type="button"
                    class="quiet-button"
                    aria-expanded={correcting() ? "true" : "false"}
                    onClick={() => setCorrecting((open) => !open)}
                  >
                    Request configuration changes
                  </button>
                  <Show when={correcting()}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act();
                      }}
                    >
                      <label>
                        Requested configuration changes
                        <textarea
                          required
                          maxlength={2000}
                          disabled={blocked()}
                          value={answers()[setupFeedbackKey] ?? ""}
                          onInput={(event) => answer(setupFeedbackKey, event.currentTarget.value)}
                        />
                      </label>
                      <p class="setup-note">
                        Name the tools, ports or checks to correct. This requests another proposal;
                        it does not apply configuration. Do not include credentials.
                      </p>
                      <button type="submit" class="quiet-button" disabled={blocked()}>
                        {busy() && pending()?.operation === "inspect"
                          ? "Revising proposal…"
                          : "Request changes"}
                      </button>
                    </form>
                  </Show>
                </Show>
                <button
                  type="button"
                  class="primary-button"
                  disabled={blocked()}
                  onClick={() => void act("confirm")}
                >
                  {busy() && pending()?.operation === "confirm"
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
            disabled={blocked()}
            onClick={() => void act("stop")}
          >
            Discard proposal
          </button>
        </Show>
        <Show
          when={value() === null || value()?.state === "failed" || value()?.state === "superseded"}
        >
          <button
            type="button"
            class="primary-button"
            disabled={blocked()}
            onClick={() => void act()}
          >
            {busy()
              ? "Inspecting…"
              : value()?.state === "failed"
                ? "Retry setup inspection"
                : "Inspect project setup"}
          </button>
        </Show>
        <Show when={value()?.failure && pending()?.operation !== "inspect"}>
          <p class="setup-note">{value()?.failure}</p>
        </Show>
      </Show>
      <Show when={pending() && !busy()}>
        <div class="setup-submission-recovery" role="status">
          <p>
            This submission is not confirmed. Your submitted answers are retained. Check its status
            or retry the same submission before editing.
          </p>
          <button
            type="button"
            class="quiet-button"
            disabled={reading()}
            onClick={() => void load()}
          >
            Check inspection status
          </button>
          <button
            type="button"
            class="primary-button"
            onClick={() => {
              const command = pending();
              if (command) void act(command.operation);
            }}
          >
            Retry submitted setup
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={readFailed() && !pending()}>
        <button type="button" class="quiet-button" disabled={reading()} onClick={() => void load()}>
          {reading() ? "Checking inspection…" : "Retry inspection status"}
        </button>
      </Show>
    </section>
  );
}
