import { createEffect, createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { identityConfiguration } from "../../../../packages/identity-domain/src/configuration";
import { protocolRequest } from "../api-client";
import {
  getIdentityConfiguration,
  saveIdentityConfiguration,
  activateIdentityConfiguration,
} from "../server-functions/access";
import { serverCall, type ServerValue } from "../server-functions/result";

export function IdentitySettings(props: { beforeCompanySignIn?: (() => void) | undefined }) {
  const [current, setCurrent] =
    createSignal<ServerValue<ReturnType<typeof getIdentityConfiguration>>>();
  const [mode, setMode] = createSignal("local");
  const [issuer, setIssuer] = createSignal("");
  const [days, setDays] = createSignal(7);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  let pendingCommandID = crypto.randomUUID();
  let lastInput = "";
  async function load() {
    const view = await serverCall(getIdentityConfiguration());
    setCurrent(view);
    setMode(view.mode);
    setIssuer(view.issuer ?? "");
    setDays(view.sessionDays);
  }
  async function act(operation: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sign-in");
    } finally {
      setBusy(false);
    }
  }
  createEffect(
    () => undefined,
    () => {
      void act(load);
    },
  );
  async function save(form: HTMLFormElement) {
    const values = new FormData(form);
    const configuration = identityConfiguration.parse({
      mode: mode(),
      sessionDays: days(),
      ...(mode() === "oidc"
        ? {
            issuer: issuer(),
            clientID: values.get("clientID"),
            clientSecret: values.get("clientSecret"),
            domain: values.get("domain"),
            ...(values.get("directoryToken")
              ? { directoryToken: values.get("directoryToken") }
              : {}),
            directorySubjectClaim: values.get("directorySubjectClaim") || "oid",
          }
        : {}),
    });
    const input = JSON.stringify({ version: current()?.version ?? 0, configuration });
    if (input !== lastInput) {
      pendingCommandID = crypto.randomUUID();
      lastInput = input;
    }
    const result = await serverCall(
      saveIdentityConfiguration({
        commandID: pendingCommandID,
        version: current()?.version ?? 0,
        configuration,
      }),
    );
    setCurrent(result);
    for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      field.value = "";
    lastInput = "";
    setNotice(
      mode() === "local"
        ? "Saved. Activate to use this session policy."
        : "Saved securely. Check company sign-in before activating.",
    );
  }
  async function check(commandID: string) {
    props.beforeCompanySignIn?.();
    const result = await protocolRequest(z.object({ url: z.url() }), "/api/auth/sign-in/sso", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setupCommandID: commandID,
        providerId: "company",
        callbackURL: location.origin,
      }),
    });
    location.assign(result.url);
  }
  async function activate(commandID: string) {
    const result = await serverCall(activateIdentityConfiguration(commandID));
    setCurrent(result);
    setNotice("Sign-in configuration activated. Background Agents continue.");
  }
  return (
    <section aria-label="Factory sign-in configuration">
      <p class="model-settings-note">
        One identity provider for this installation. No project membership is granted by signing in.
      </p>
      <Show when={current()}>
        {(value) => (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              void act(() => save(form));
            }}
          >
            <label>
              Sign-in method
              <select
                value={mode()}
                disabled={busy()}
                onChange={(event) => setMode(event.currentTarget.value)}
              >
                <option value="local">Managed Factory accounts</option>
                <option value="oidc">Company OIDC / Microsoft Entra ID</option>
              </select>
            </label>
            <Show when={mode() === "oidc"}>
              <label>
                Issuer URL
                <input
                  name="issuer"
                  type="url"
                  value={issuer()}
                  required
                  disabled={busy()}
                  placeholder="https://login.microsoftonline.com/tenant-id/v2.0"
                  onInput={(event) => setIssuer(event.currentTarget.value)}
                />
                <small>Entra: use the tenant-specific issuer, never common or organizations.</small>
              </label>
              <label>
                Client ID
                <input
                  name="clientID"
                  value={value().clientID ?? ""}
                  required
                  disabled={busy()}
                  autocomplete="off"
                />
              </label>
              <label>
                Client secret
                <input
                  name="clientSecret"
                  type="password"
                  required
                  minlength={16}
                  disabled={busy()}
                  autocomplete="new-password"
                />
                <small>Encrypted in OpenBao. Never shown after saving.</small>
              </label>
              <label>
                Company domain
                <input
                  name="domain"
                  value={value().domain ?? ""}
                  required
                  disabled={busy()}
                  placeholder="company.com"
                />
              </label>
              <p class="model-settings-note">
                Callback: <code>{location.origin}/api/auth/sso/callback/company</code>
              </p>
              <details>
                <summary>Optional directory provisioning</summary>
                <label>
                  SCIM bearer token
                  <input
                    name="directoryToken"
                    type="password"
                    minlength={32}
                    disabled={busy()}
                    autocomplete="new-password"
                  />
                </label>
                <label>
                  Stable directory claim
                  <input name="directorySubjectClaim" value="oid" disabled={busy()} />
                </label>
                <p class="model-settings-note">
                  SCIM endpoint: {location.origin}/api/auth/scim/v2. Entra externalId must match the
                  verified oid claim. Directory changes grant no project roles.
                </p>
              </details>
            </Show>
            <label>
              Browser session duration
              <input
                name="sessionDays"
                type="number"
                min={1}
                max={30}
                value={days()}
                onInput={(event) => setDays(Number(event.currentTarget.value))}
                disabled={busy()}
              />
              <small>Days, renewed by activity. Company sign-in is revalidated daily.</small>
            </label>
            <button
              type="submit"
              class="primary-button"
              disabled={busy() || !value().storeConfigured}
            >
              {busy() ? "Saving" : "Save sign-in setup"}
            </button>
            <Show when={!value().storeConfigured}>
              <p class="model-settings-note">
                Connect OpenBao to save protected sign-in configuration.
              </p>
            </Show>
          </form>
        )}
      </Show>
      <For each={current()?.candidates}>
        {(candidate) => (
          <div class="access-list">
            <p>{candidate.mode === "oidc" ? candidate.issuer : "Managed account policy"}</p>
            <Show
              when={candidate.state === "saved"}
              fallback={
                <p class="model-settings-note">Protected save pending. Retry the same save.</p>
              }
            >
              <Show
                when={candidate.mode === "oidc" && !candidate.tested}
                fallback={
                  <button
                    type="button"
                    class="primary-button"
                    disabled={busy()}
                    onClick={() => void act(() => activate(candidate.commandID))}
                  >
                    Activate sign-in
                  </button>
                }
              >
                <button
                  type="button"
                  class="primary-button"
                  disabled={busy()}
                  onClick={() => void act(() => check(candidate.commandID))}
                >
                  Check company sign-in
                </button>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <Show when={notice()}>
        <p role="status" class="model-settings-note">
          {notice()}
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="error">
          {error()}
        </p>
        <button type="button" class="quiet-button" disabled={busy()} onClick={() => void act(load)}>
          Reload sign-in settings
        </button>
      </Show>
    </section>
  );
}
