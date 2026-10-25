import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { ChangeWriterStatus } from "../../apps/factory/src/writer-status";
import "@fontsource-variable/inter";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";

function Surface() {
  const [active, setActive] = createSignal(true);
  const [epoch, setEpoch] = createSignal("unset");
  return (
    <main class="factory-desktop" style={{ padding: "24px", overflow: "auto" }}>
      <h1>Shared editing · scripted fixture</h1>
      <div>
        <button type="button" onClick={() => setActive(!active())}>
          {active() ? "Hide writing status" : "Show writing status"}
        </button>
      </div>
      <div style={{ "max-width": "40rem", padding: "24px 0" }}>
        <ChangeWriterStatus
          changeID="10000000-0000-4000-8000-000000000003"
          active={active()}
          onStatus={(_id, view) => setEpoch(view ? String(view.epoch) : "unset")}
        />
        <output aria-label="Published writer epoch">{epoch()}</output>
      </div>
    </main>
  );
}
render(() => <Surface />, document.getElementById("root")!);
