import { expect, test } from "bun:test";
import { proveProjectImageRecovery } from "../fixtures/browser-image-recovery";

test.skipIf(process.env["FACTORY_RUN_PROJECT_IMAGE_RECOVERY_PROOF"] !== "1")(
  "native Docker recovers the exact Project image after a TLS Registry outage without starting a container or model",
  async () => {
    expect(await proveProjectImageRecovery()).toEqual({
      pulls: 2,
      imageConfirmed: true,
      modelRequests: 0,
      applicationCalls: 0,
    });
  },
  180_000,
);
