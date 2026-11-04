import { createSignal, Show } from "solid-js";
import {
  checkPasswordChange,
  passwordChangeMessage,
  passwordPolicy,
} from "../../../../packages/auth/src/password-policy";
import { changeOwnPassword } from "../server-functions/access";
import { serverCall } from "../server-functions/result";
import "./settings.css";

export function PasswordChange(props: { fresh: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal(false);
  const reasonID = "password-change-reason";
  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const input = {
      currentPassword: String(data.get("currentPassword") ?? ""),
      newPassword: String(data.get("newPassword") ?? ""),
      confirmPassword: String(data.get("confirmPassword") ?? ""),
    };
    setError("");
    setDone(false);
    const refusal = checkPasswordChange(input);
    if (refusal) {
      setError(passwordChangeMessage(refusal));
      return;
    }
    setBusy(true);
    try {
      await serverCall(changeOwnPassword({ data: [input] }));
      form.reset();
      setDone(true);
    } catch (cause) {
      form.querySelector<HTMLInputElement>('input[name="currentPassword"]')?.select();
      setError(cause instanceof Error ? cause.message : "The password could not be changed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Change password">
      <h3>Change password</h3>
      <p class="model-settings-note">
        Choose a password of {passwordPolicy.minLength} to {passwordPolicy.maxLength} characters.
        Other browser sessions sign out; this one stays signed in. Agents keep running.
      </p>
      <form
        class="access-password-form"
        novalidate
        onSubmit={(event) => {
          event.preventDefault();
          if (props.fresh && !busy()) void submit(event.currentTarget);
        }}
      >
        <label class="control-field">
          Current password
          <input
            name="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            maxlength={1024}
            disabled={busy()}
          />
        </label>
        <label class="control-field">
          New password
          <input
            name="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength={passwordPolicy.minLength}
            maxlength={passwordPolicy.maxLength}
            disabled={busy()}
          />
        </label>
        <label class="control-field">
          Confirm new password
          <input
            name="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength={passwordPolicy.minLength}
            maxlength={passwordPolicy.maxLength}
            disabled={busy()}
          />
        </label>
        <button
          type="submit"
          class="primary-button"
          disabled={busy() || !props.fresh}
          aria-describedby={props.fresh ? undefined : reasonID}
        >
          {busy() ? "Changing password" : "Change password"}
        </button>
        <Show when={!props.fresh}>
          <p class="model-settings-note" id={reasonID}>
            Confirm your identity above before changing your password.
          </p>
        </Show>
      </form>
      <Show when={done()}>
        <p role="status" class="model-settings-note">
          Password changed. Other browser sessions were signed out. Use the new password next time
          you sign in.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="access-error">
          {error()}
        </p>
      </Show>
    </section>
  );
}
