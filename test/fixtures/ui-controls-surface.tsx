import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { isDesktopBackgroundKey } from "../../packages/interface-domain/src/background";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "./ui-controls.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";

// Deliberately no ActionBar or feature stylesheet. A bare workspace action
// must have the same appearance before and after another feature is loaded.
function Controls() {
  const [notice, setNotice] = createSignal("No action taken.");
  const [delivery, setDelivery] = createSignal("human");
  const parameters = new URLSearchParams(location.search);
  const requested = parameters.get("background");
  return (
    <main
      class={`control-catalog${parameters.has("desktop") ? " factory-desktop" : ""}`}
      data-background={isDesktopBackgroundKey(requested) ? requested : "river-landscape"}
    >
      <header>
        <h1>Factory controls</h1>
        <p>Shared controls and their states. These examples commission no work.</p>
      </header>
      <section aria-label="Actions">
        <h2>Actions</h2>
        <div class="control-actions">
          <button class="workspace-action" type="button" onClick={() => setNotice("Cancelled.")}>
            Cancel
          </button>
          <button
            class="workspace-action"
            data-primary="true"
            type="button"
            onClick={() => setNotice("Draft saved in this fixture.")}
          >
            Save draft
          </button>
          <button class="quiet-button" type="button">
            Inspect
          </button>
          <button class="primary-button" type="button">
            Run check
          </button>
          <button class="danger-button" type="button">
            Delete draft
          </button>
          <button class="workspace-action" type="button" disabled>
            Unavailable
          </button>
          <button class="workspace-action" type="button" disabled aria-busy="true">
            Saving…
          </button>
        </div>
        <p role="status">{notice()}</p>
      </section>
      <section aria-label="Form controls">
        <h2>Form controls</h2>
        <div class="control-catalog-fields">
          <label class="control-field">
            Project name
            <input placeholder="Billing" />
          </label>
          <label class="control-field">
            Delivery mode
            <select value={delivery()} onChange={(event) => setDelivery(event.currentTarget.value)}>
              <option value="human">Human approval</option>
              <option value="automatic">Automatic delivery</option>
            </select>
          </label>
          <label class="control-field">
            Unavailable selection
            <select disabled>
              <option>Human approval</option>
            </select>
          </label>
          <div class="control-field">
            <label for="control-required-name">Required name</label>
            <input
              id="control-required-name"
              aria-invalid="true"
              aria-describedby="control-name-error"
            />
            <small id="control-name-error" class="error">
              Enter a Project name.
            </small>
          </div>
          <label class="control-field control-catalog-description">
            Description
            <textarea placeholder="Describe the approved outcome." />
          </label>
        </div>
        <label class="control-check">
          <input type="checkbox" />
          Keep the existing Project permissions when delivering an approved change.
        </label>
        <output aria-label="Selected delivery mode">{delivery()}</output>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Shared controls fixture root is missing");
render(() => <Controls />, root);
