import { render } from "@solidjs/web";
import { ReviewPanel } from "../../apps/factory/src/review/panel";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import { fixtureValue } from "./value";

render(
  () => (
    <main>
      <h1>Review transport fixture</h1>
      <ReviewPanel
        changeID="10000000-0000-4000-8000-000000000003"
        userID="10000000-0000-4000-8000-000000000006"
        canDevelop
        active
      />
    </main>
  ),
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
