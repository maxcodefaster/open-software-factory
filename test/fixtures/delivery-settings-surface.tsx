import { render } from "@solidjs/web";
import { DeliverySettings } from "../../apps/factory/src/delivery/settings";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "../../apps/factory/src/monitoring/settings.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import { fixtureValue } from "./value";

render(
  () => (
    <main class="model-settings-body input-settings">
      <DeliverySettings projectID="10000000-0000-4000-8000-000000000001" active />
    </main>
  ),
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
