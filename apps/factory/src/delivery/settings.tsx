import { createEffect, createSignal, Show } from "solid-js";
import type { z } from "zod";
import type { deliverySettingsView } from "../../../../packages/change-domain/src/delivery";
import { configureDelivery, getDeliverySettings } from "../server-functions/delivery";
import { serverCall } from "../server-functions/result";

export function DeliverySettings(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<z.infer<typeof deliverySettingsView>>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [consent, setConsent] = createSignal(false);
  let generation = 0;
  let command: { id: string; enabled: boolean; expectedPolicyId: string | null } | undefined;
  async function load(id = props.projectID) {
    const epoch = generation;
    try {
      const value = await serverCall(getDeliverySettings({ data: [id] }));
      if (epoch !== generation || props.projectID !== id) return;
      setView(value);
      setError("");
      if (value.enabled) {
        setConfirming(false);
        setConsent(false);
      }
    } catch (cause) {
      if (epoch === generation)
        setError(cause instanceof Error ? cause.message : "Could not load Delivery settings.");
    }
  }
  createEffect(
    () => [props.projectID, props.active] as const,
    ([id, active]) => {
      generation++;
      setView(undefined);
      setBusy(false);
      setConfirming(false);
      setConsent(false);
      command = undefined;
      if (active) void load(id);
      return () => {
        generation++;
      };
    },
  );
  async function save(enabled: boolean) {
    const current = view(),
      epoch = generation,
      id = props.projectID;
    if (!current || busy()) return;
    if (!command || command.enabled !== enabled || command.expectedPolicyId !== current.policyId)
      command = { id: crypto.randomUUID(), enabled, expectedPolicyId: current.policyId };
    setBusy(true);
    setError("");
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
      setConfirming(false);
      setConsent(false);
      command = undefined;
    } catch (cause) {
      if (epoch === generation)
        setError(
          cause instanceof Error
            ? cause.message
            : "Delivery setting is unconfirmed. Retry the same decision.",
        );
    } finally {
      if (epoch === generation) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Automatic Ticket Delivery"
      aria-busy={busy() || (!view() && !error()) ? "true" : "false"}
      class="input-delivery-settings"
    >
      <h3>Automatic Ticket Delivery</h3>
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
                disabled={busy() || (value().enabled ? !value().canManage : !value().canDelegate)}
                onClick={() => (value().enabled ? void save(false) : setConfirming(true))}
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
            </Show>
            <Show when={confirming()}>
              <label class="control-check">
                <input
                  type="checkbox"
                  checked={consent()}
                  disabled={busy()}
                  onChange={(event) => setConsent(event.currentTarget.checked)}
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
                  onClick={() => {
                    setConfirming(false);
                    setConsent(false);
                  }}
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
