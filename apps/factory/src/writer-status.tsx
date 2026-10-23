import { createEffect, createSignal, For, Show } from "solid-js";
import { apiRequest } from "./api-client";
import { type WriterView, writerViewSchema } from "./api-contracts";

export function writerStatusText(view: WriterView) {
  if (view.state === "human")
    return view.canWrite
      ? "You are editing"
      : `${view.actor?.user?.name ?? "Another developer"} ${view.presence?.idle ? "holds editing · no recent edits" : "is editing"}`;
  if (view.state === "handoff")
    if (view.handoffKind === "release") return "Releasing editing · stopping previous commands";
    else
      return view.requester
        ? `Transferring editing to ${view.requester.name}`
        : "Editing handoff in progress";
  if (view.state === "agent" || view.state === "agent-preparing") {
    const work = view.actor?.workState;
    const label =
      work === "uncertain"
        ? "Agent outcome unconfirmed"
        : work === "failed"
          ? "Agent work failed"
          : ["completed", "stopped"].includes(work ?? "")
            ? "Agent work settled"
            : view.state === "agent-preparing"
              ? "Agent preparing"
              : "Agent working";
    return `${label}${view.actor?.user ? ` · ${view.actor.delegated ? "delegated" : "requested"} by ${view.actor.user.name}` : ""}`;
  }
  return "Editing is available";
}

export function ChangeWriterStatus(props: {
  changeID: string | undefined;
  active: boolean;
  onStatus?: ((changeID: string, view: WriterView | undefined) => void) | undefined;
}) {
  const [view, setView] = createSignal<WriterView>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [confirmation, setConfirmation] = createSignal<{
    changeID: string;
    epoch: number;
    action: "release" | "idle-takeover" | "approve";
    commandID: string;
    requestID?: string;
  }>();
  createEffect(
    () => [props.changeID, props.active] as const,
    ([id, active]) => {
      setView(undefined);
      setUnavailable(false);
      setConfirmation(undefined);
      setError("");
      setBusy(false);
      if (id) props.onStatus?.(id, undefined);
      if (!id || !active) return;
      const cancellation = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async () => {
        try {
          const current = await apiRequest(writerViewSchema, `/api/changes/${id}/writer/status`, {
            signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(8_000)]),
          });
          if (!cancellation.signal.aborted) {
            setView(current);
            props.onStatus?.(id, current);
            setUnavailable(false);
          }
        } catch {
          if (!cancellation.signal.aborted) {
            setView(undefined);
            setUnavailable(true);
          }
        } finally {
          if (!cancellation.signal.aborted) timer = setTimeout(() => void read(), 2_000);
        }
      };
      void read();
      return () => {
        cancellation.abort();
        clearTimeout(timer);
      };
    },
  );
  async function command(
    action: string,
    epoch: number,
    commandID: string = crypto.randomUUID(),
    requestID?: string,
  ) {
    const id = props.changeID;
    if (!id || busy()) return;
    setBusy(true);
    setError("");
    try {
      const current = await apiRequest(writerViewSchema, `/api/changes/${id}/writer/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epoch, commandID, ...(requestID ? { requestID } : {}) }),
      });
      if (props.changeID === id) {
        setView(current);
        props.onStatus?.(id, current);
        setConfirmation(undefined);
      }
    } catch (cause) {
      if (props.changeID === id)
        setError(
          cause instanceof Error
            ? cause.message
            : "Editing could not be transferred. Check its status.",
        );
    } finally {
      if (props.changeID === id) setBusy(false);
    }
  }
  function confirm(
    action: "release" | "idle-takeover" | "approve",
    epoch: number,
    requestID?: string,
  ) {
    if (!props.changeID) return;
    setConfirmation({
      changeID: props.changeID,
      epoch,
      action,
      commandID: crypto.randomUUID(),
      ...(requestID ? { requestID } : {}),
    });
  }
  const status = () => {
    const current = view();
    return current
      ? writerStatusText(current)
      : unavailable()
        ? "Editing status unavailable. Writing authority has not changed."
        : "Checking editing status…";
  };
  return (
    <Show when={props.active && props.changeID}>
      <section class="agent-writer-status" aria-label="Shared editing">
        <p role="status">{status()}</p>
        <Show when={view()}>
          {(current) => (
            <div class="agent-writer-actions">
              <Show when={current().canWrite}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() => confirm("release", current().epoch)}
                >
                  Release editing
                </button>
                <For each={current().requests}>
                  {(request) => (
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={busy()}
                      onClick={() => confirm("approve", request.epoch, request.id)}
                    >
                      Give editing to {request.requester.name}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={current().state === "human" && !current().canWrite}>
                <Show when={!current().requests.length} fallback={<span>Editing requested</span>}>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busy()}
                    onClick={() => void command("request", current().epoch)}
                  >
                    Request editing
                  </button>
                </Show>
                <Show when={current().presence?.idle}>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busy()}
                    onClick={() => confirm("idle-takeover", current().epoch)}
                  >
                    Take over editing
                  </button>
                </Show>
              </Show>
              <Show
                when={
                  current().state === "handoff" &&
                  current().yours &&
                  current().handoffKind === "release"
                }
              >
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy()}
                  onClick={() =>
                    void command("release", current().epoch - 1, current().commandID ?? undefined)
                  }
                >
                  Continue release
                </button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={confirmation()}>
          {(target) => (
            <div class="agent-editing-confirmation">
              <p>
                {target().action === "idle-takeover"
                  ? "No recent edits were observed. Taking over stops the previous developer's commands. Their unsaved editor buffers remain theirs."
                  : "Save your files first. This stops your commands and ends your writing access. Unsaved editor buffers are not transferred."}
              </p>
              <button
                type="button"
                class="quiet-button"
                disabled={
                  busy() ||
                  (view()?.epoch !== target().epoch && view()?.commandID !== target().commandID)
                }
                onClick={() =>
                  void command(
                    target().action,
                    target().epoch,
                    target().commandID,
                    target().requestID,
                  )
                }
              >
                {busy() ? "Transferring…" : "Confirm"}
              </button>
              <button
                type="button"
                class="quiet-button"
                disabled={busy()}
                onClick={() => setConfirmation(undefined)}
              >
                Cancel
              </button>
              <Show
                when={view()?.epoch !== target().epoch && view()?.commandID !== target().commandID}
              >
                <p>The writer changed. Check the current status before trying again.</p>
              </Show>
            </div>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </section>
    </Show>
  );
}
