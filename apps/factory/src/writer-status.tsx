import { createEffect, createSignal, For, Show } from "solid-js";
import { APIRequestError } from "./api-client";
import type { WriterView } from "./api-contracts";
import { serverCall } from "./server-functions/result";
import {
  approveChangeEditing,
  getChangeWriterStatus,
  releaseChangeEditing,
  requestChangeEditing,
  takeOverIdleEditing,
} from "./server-functions/writer";

export function writerStatusText(view: WriterView) {
  if (view.stopPending) return "Agent Stop unconfirmed. Check Stop in this Ticket.";
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
  let generation = 0;
  let readFence = 0;
  let pendingRequest: { changeID: string; epoch: number; commandID: string } | undefined;
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
      const scope = ++generation;
      readFence++;
      pendingRequest = undefined;
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
        const fence = readFence;
        try {
          const current = await serverCall(
            getChangeWriterStatus({
              signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(8_000)]),
              data: [id],
            }),
          );
          if (!cancellation.signal.aborted && scope === generation && fence === readFence) {
            setView(current);
            props.onStatus?.(id, current);
            setUnavailable(false);
          }
        } catch {
          if (!cancellation.signal.aborted && scope === generation && fence === readFence) {
            setView(undefined);
            setUnavailable(true);
          }
        } finally {
          if (!cancellation.signal.aborted) timer = setTimeout(() => void read(), 2_000);
        }
      };
      void read();
      return () => {
        if (generation === scope) generation++;
        cancellation.abort();
        clearTimeout(timer);
      };
    },
  );
  async function command(
    action: "request" | "release" | "approve" | "idle-takeover",
    epoch: number,
    commandID?: string,
    requestID?: string,
    changeID = props.changeID,
  ) {
    const id = changeID;
    if (!id || id !== props.changeID || busy()) return;
    const scope = generation;
    readFence++;
    if (action === "request" && !commandID) {
      if (!pendingRequest || pendingRequest.changeID !== id || pendingRequest.epoch !== epoch)
        pendingRequest = { changeID: id, epoch, commandID: crypto.randomUUID() };
      commandID = pendingRequest.commandID;
    }
    commandID ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const input = { epoch, commandID, ...(requestID ? { requestID } : {}) };
      let current: WriterView;
      if (action === "request")
        current = await serverCall(requestChangeEditing({ data: [id, input] }));
      else if (action === "release")
        current = await serverCall(releaseChangeEditing({ data: [id, input] }));
      else if (action === "approve")
        current = await serverCall(approveChangeEditing({ data: [id, input] }));
      else current = await serverCall(takeOverIdleEditing({ data: [id, input] }));
      if (props.changeID === id && scope === generation) {
        readFence++;
        if (action === "request") pendingRequest = undefined;
        setView(current);
        props.onStatus?.(id, current);
        setConfirmation(undefined);
      }
    } catch (cause) {
      if (props.changeID === id && scope === generation) {
        readFence++;
        if (action === "request" && cause instanceof APIRequestError && cause.status < 500)
          pendingRequest = undefined;
        setError(
          cause instanceof Error
            ? cause.message
            : "Editing could not be transferred. Check its status.",
        );
      }
    } finally {
      if (props.changeID === id && scope === generation) setBusy(false);
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
                  disabled={busy() || !current().commandID}
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
                    target().changeID,
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
