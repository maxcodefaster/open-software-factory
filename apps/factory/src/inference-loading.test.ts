import { expect, test } from "bun:test";
import { generateWiki } from "./knowledge/generation-agent";
import { diagnoseMonitoringIncident } from "./monitoring/diagnosis";
import { generateProjectResponse } from "./project-agent/adapter";
import { inspectConfiguration } from "./setup/inspection-agent";

const adapters = {
  research: (signal: AbortSignal) =>
    generateProjectResponse({ signal } as Parameters<typeof generateProjectResponse>[0]),
  knowledge: (signal: AbortSignal) =>
    generateWiki({ signal } as Parameters<typeof generateWiki>[0]),
  monitoring: (signal: AbortSignal) =>
    diagnoseMonitoringIncident({ signal } as Parameters<typeof diagnoseMonitoringIncident>[0]),
  setup: (signal: AbortSignal) =>
    inspectConfiguration({ signal } as Parameters<typeof inspectConfiguration>[0]),
};

for (const [name, invoke] of Object.entries(adapters)) {
  test(`${name} preserves cancellation before and during lazy engine loading`, async () => {
    for (const beforeImport of [true, false]) {
      const controller = new AbortController();
      const reason = new Error("Owned cancellation before inference");
      if (beforeImport) controller.abort(reason);
      const pending = invoke(controller.signal);
      if (!beforeImport) controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    }
  });
}
