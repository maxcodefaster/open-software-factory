import type { Accessor } from "solid-js";
import { CopyButton } from "../ui/feedback";
import type { MonitoringSettingsState } from "./settings-state";
import type { MonitoringScreen } from "./settings-types";

type SecretScreen = Extract<MonitoringScreen, { kind: "secret" }>;

export function MonitoringSecretView(props: {
  secret: Accessor<SecretScreen | undefined>;
  state: MonitoringSettingsState;
}) {
  return (
    <section class="input-setup-result" aria-label="New webhook URL">
      <h3
        tabindex="-1"
        ref={(element) => {
          props.state.refs.setupHeading = element;
        }}
      >
        {props.secret()?.rotated
          ? "New key created. Your Input is disabled."
          : "Your Input is ready to receive requests"}
      </h3>
      <p>Copy this private URL into your sender's webhook settings. Its key is shown only now.</p>
      <div class="input-webhook">
        <label class="control-field">
          Webhook URL
          <input
            type={props.secret()?.revealed ? "text" : "password"}
            readonly
            value={props.secret()?.url ?? ""}
            autocomplete="off"
            spellcheck={false}
          />
        </label>
        <div class="input-actions">
          <button
            type="button"
            class="workspace-action"
            onClick={() => props.state.toggleSecretReveal()}
          >
            {props.secret()?.revealed ? "Hide URL" : "Reveal URL"}
          </button>
          <CopyButton
            value={props.secret()?.url ?? ""}
            label="Copy URL"
            accessibleLabel="Copy URL"
            scope={props.secret()?.projectId ?? ""}
            class="workspace-action input-copy-action"
            successMessage="Webhook URL copied. Keep it private."
            errorMessage="Reveal the URL and copy it manually."
          />
        </div>
      </div>
      <p class="input-help">
        {props.secret()?.rotated
          ? "Update the sender, then edit this Input to review and enable it. Earlier work is not resumed."
          : "Waiting for the first request. Creating an Input does not call a model; incoming requests do."}
      </p>
      <button type="button" class="workspace-action" onClick={() => props.state.dismissSecret()}>
        Back to inputs
      </button>
    </section>
  );
}
