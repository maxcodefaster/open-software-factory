import { expect, test } from "bun:test";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";

test.each([
  "http://git.native.test/",
  "https://user:secret@git.native.test/",
  "https://git.native.test/path",
  "https://git.native.test/?secret=value",
  "https://git.native.test/#fragment",
])(
  "owned native Forge rejects non-origin public routing before any resource or credential operation: %s",
  async (origin) => {
    await expect(
      ownedMonitoringForge("/not-dispatched", crypto.randomUUID(), undefined, origin),
    ).rejects.toThrow("exact owned Forge public HTTPS origin");
  },
);
