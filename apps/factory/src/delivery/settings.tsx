import { createEffect, createSignal, Show } from "solid-js";
import type { z } from "zod";
import type { deliverySettingsView } from "#change-domain/delivery";
import { plainErrorMessage } from "../command-error";
import { configureDelivery, getDeliverySettings } from "../server-functions/delivery";
import { serverCall } from "../server-functions/result";

type DeliveryView = z.infer<typeof deliverySettingsView>;

type DeliveryCommandState =
  | { kind: "idle" }
  | { kind: "confirming"; consent: boolean; error?: string }
  | { kind: "saving"; confirming: boolean; consent: boolean }
  | { kind: "error"; message: string };

function blocked(view: DeliveryView) {
  if (view.enabled)
    return view.canManage ? undefined : "Only a Project manager can turn off automatic Delivery.";
  if (view.canDelegate) return undefined;
  return view.canManage
    ? "Enabling automatic Delivery needs Developer access to this Project."
    : "Only a Project manager with Developer access can enable automatic Delivery.";
}

export function DeliverySettings(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<DeliveryView>();
  const [state, setState] = createSignal<DeliveryCommandState>({ kind: "idle" });
  let generation = 0;
  let command: { id: string; enabled: boolean; expectedPolicyId: string | null } | undefined;

  const busy = () => state().kind === "saving";
  const confirming = () => {
    const current = state();
    return current.kind === "confirming" || (current.kind === "saving" && current.confirming);
  };
  const consent = () => {
    const current = state();
    return (current.kind === "confirming" || current.kind === "saving") && current.consent;
  };
  const error = () => {
    const current = state();
    return current.kind === "error"
      ? current.message
      : current.kind === "confirming"
        ? (current.error ?? "")
        : "";
  };

  async function load(id = props.projectID) {
    const epoch = generation;
    try {
      const value = await serverCall(getDeliverySettings({ data: [id] }));
      if (epoch !== generation || props.projectID !== id) return;
      setView(value);
      setState((current) =>
        !value.enabled && current.kind === "confirming"
          ? { kind: "confirming", consent: current.consent }
          : { kind: "idle" },
      );
    } catch (cause) {
      if (epoch !== generation) return;
      const message =
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Could not load Delivery settings.";
      setState((current) =>
        current.kind === "confirming"
          ? { kind: "confirming", consent: current.consent, error: message }
          : { kind: "error", message },
      );
    }
  }

  createEffect(
    () => [props.projectID, props.active] as const,
    ([id, active]) => {
      generation++;
      setView(undefined);
      setState({ kind: "idle" });
      command = undefined;
      if (active) void load(id);
      return () => {
        generation++;
      };
    },
  );

  async function save(enabled: boolean) {
    const current = view();
    const epoch = generation;
    const id = props.projectID;
    if (!current || busy()) return;
    if (!command || command.enabled !== enabled || command.expectedPolicyId !== current.policyId) {
      command = { id: crypto.randomUUID(), enabled, expectedPolicyId: current.policyId };
    }
    const wasConfirming = confirming();
    const hadConsent = consent();
    setState({ kind: "saving", confirming: wasConfirming, consent: hadConsent });
    try {
      const value = await serverCall(
        configureDelivery({
          data: [
            id,
            {
              commandId: command.id,
              enabled,
              expectedPolicyId: current.policyId,
            },
          ],
        }),
      );
      if (epoch !== generation) return;
      setView(value);
      setState({ kind: "idle" });
      command = undefined;
    } catch (cause) {
      if (epoch !== generation) return;
      const message =
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Delivery setting is unconfirmed. Retry the same decision.";
      setState(
        wasConfirming
          ? { kind: "confirming", consent: hadConsent, error: message }
          : { kind: "error", message },
      );
    }
  }

  return (
    <section
      aria-label="Automatic Ticket Delivery"
      aria-busy={busy() || (!view() && !error()) ? "true" : "false"}
      class="input-delivery-settings"
    >
      <h2>Automatic Ticket Delivery</h2>
      <p class="input-help">
        Deliver approved application changes after fresh Verification and independent review.
        Prerequisite Tickets must be delivered first. Infrastructure, migrations, dependency
        upgrades and access-policy changes still need human approval.
      </p>
      <Show when={error()}>
        <p role="alert" class="input-error">
          {error()}
        </p>
        <button
          type="button"
          class="workspace-action"
          disabled={busy()}
          onClick={() => void load()}
        >
          Reload Delivery settings
        </button>
      </Show>
      <Show
        when={view()}
        fallback={
          <Show when={!error()}>
            <p role="status">Loading Delivery settings…</p>
          </Show>
        }
      >
        {(value) => (
          <>
            <p role="status">
              {value().enabled
                ? "Automatic Delivery is enabled for eligible Tickets."
                : value().policyId
                  ? "Delivery delegation is inactive. Renew it with current authority."
                  : "Each Ticket requires human Delivery approval."}
            </p>
            <Show when={!confirming()}>
              <button
                type="button"
                class="workspace-action"
                data-primary={!value().enabled ? "true" : undefined}
                aria-describedby={blocked(value()) ? "delivery-authority-reason" : undefined}
                disabled={busy() || Boolean(blocked(value()))}
                onClick={() =>
                  value().enabled
                    ? void save(false)
                    : setState({ kind: "confirming", consent: false })
                }
              >
                {busy()
                  ? "Saving Delivery settings…"
                  : value().enabled
                    ? "Disable automatic Delivery"
                    : "Enable automatic Delivery"}
              </button>
              <Show when={!value().enabled && value().policyId}>
                <button
                  type="button"
                  class="workspace-action"
                  disabled={busy() || !value().canManage}
                  onClick={() => void save(false)}
                >
                  Revoke inactive delegation
                </button>
              </Show>
              <Show when={blocked(value())}>
                {(reason) => (
                  <p class="input-help" id="delivery-authority-reason">
                    {reason()}
                  </p>
                )}
              </Show>
            </Show>
            <Show when={confirming()}>
              <label class="control-check">
                <input
                  type="checkbox"
                  checked={consent()}
                  disabled={busy()}
                  onChange={(event) =>
                    setState((current) =>
                      current.kind === "confirming"
                        ? { ...current, consent: event.currentTarget.checked }
                        : current,
                    )
                  }
                />
                I authorize Factory to deliver eligible approved Tickets automatically, including
                new features, under my Project authority.
              </label>
              <div class="control-actions">
                <button
                  type="button"
                  class="workspace-action"
                  data-primary="true"
                  disabled={busy() || !consent()}
                  onClick={() => void save(true)}
                >
                  Confirm automatic Delivery
                </button>
                <button
                  type="button"
                  class="workspace-action"
                  disabled={busy()}
                  onClick={() => setState({ kind: "idle" })}
                >
                  Cancel
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
