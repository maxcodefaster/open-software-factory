import { expect, test } from "bun:test";
import { proveBrowserImageRecovery } from "../fixtures/browser-image-recovery";

test.skipIf(process.env["FACTORY_RUN_BROWSER_IMAGE_RECOVERY_PROOF"] !== "1")(
  "native Docker recovers the exact approved image after a TLS Registry outage without model or App execution",
  async () => {
    expect(await proveBrowserImageRecovery()).toEqual({
      pulls: 2,
      imageConfirmed: true,
      modelRequests: 0,
      applicationCalls: 0,
    });
  },
  180_000,
);
