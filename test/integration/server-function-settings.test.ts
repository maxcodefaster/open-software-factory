import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { factoryFunctionRequest } from "../fixtures/server-functions";
import type { EnvironmentSettingsView } from "../../packages/project-domain/src/environment";
import { CommandError } from "../../apps/factory/src/command-error";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("compiled settings functions validate inputs, retain host permissions and pass cancellation without replay", async () => {
  const origin = "https://factory.test";
  const projectID = crypto.randomUUID();
  const commands: string[] = [];
  let maintenance = false;
  let probeSignal: AbortSignal | undefined;
  const probeStarted = Promise.withResolvers<void>();
  const entryURL = pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href;
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    entryURL
  );
  const environment: EnvironmentSettingsView = {
    environment: "development",
    version: 1,
    variables: [],
    registries: [],
    canManage: true,
    storeConfigured: true,
    pending: false,
    pendingCommandID: null,
    preparation: null,
  };
  const services = {
    models: {
      async get() {
        throw new CommandError("forbidden", "System Manager access required");
      },
      async selectRole(actor, command, signal) {
        expect(actor).toBe("request-actor");
        commands.push(command.commandID);
        probeSignal = signal;
        probeStarted.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          status: "stopped" as const,
          modelId: command.modelId,
          toolCall: false,
          structuredOutput: false,
          limits: { requests: null, tokens: null, remainingRequests: null, remainingTokens: null },
        };
      },
    },
    environments: {
      async save(project, actor, scope, command) {
        expect([project, actor, scope]).toEqual([projectID, "request-actor", "development"]);
        commands.push(command.commandID);
        return environment;
      },
      async discard(project, actor, scope, commandID) {
        expect([project, actor, scope]).toEqual([projectID, "request-actor", "development"]);
        commands.push(commandID);
        return environment;
      },
    },
  } satisfies { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: services as unknown as FactoryServices,
    session: async () => ({ user: { id: "request-actor" } }),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("These saves did not require fresh auth");
    },
    handle: entry.handleServerFunctionRequest,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  expect(await call("getModelSettings", [])).toEqual({
    ok: false,
    status: 403,
    message: "System Manager access required",
  });
  const input = { commandID: crypto.randomUUID(), version: 0, variables: [], registries: [] };
  expect(await call("saveEnvironment", ["forged-project", "development", input])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("saveEnvironment", [projectID, "production", input])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(
    await call("saveEnvironment", [projectID, "development", { ...input, actorID: "forged" }]),
  ).toMatchObject({ ok: false, status: 400 });
  maintenance = true;
  expect(await call("saveEnvironment", [projectID, "development", input])).toMatchObject({
    ok: false,
    status: 503,
  });
  expect(commands).toEqual([]);
  maintenance = false;
  // The native handler must accept the former >1 MiB environment payload,
  // but reject a command above its existing domain limit before a secret write.
  const large = {
    ...input,
    variables: Array.from({ length: 17 }, (_, index) => ({
      name: `VALUE_${index}`,
      value: "x".repeat(65_530) + String(index).padStart(6, "0"),
      runtime: true,
      build: false,
      verification: false,
    })),
  };
  expect(await call("saveEnvironment", [projectID, "development", large])).toMatchObject({
    ok: true,
  });
  const tooLarge = {
    ...input,
    variables: Array.from({ length: 33 }, (_, index) => ({
      name: `VALUE_${index}`,
      value: "x".repeat(65_530) + String(index).padStart(6, "0"),
      runtime: true,
      build: false,
      verification: false,
    })),
  };
  const refused = await endpoint(
    await factoryFunctionRequest(origin, "saveEnvironment", [projectID, "development", tooLarge]),
  );
  expect(refused.status).toBe(413);
  expect(commands).toEqual([input.commandID]);
  expect(
    await call("discardEnvironmentSave", [projectID, "development", input.commandID]),
  ).toMatchObject({ ok: true });
  const abort = new AbortController();
  const probeID = crypto.randomUUID();
  const probe = endpoint(
    await factoryFunctionRequest(
      origin,
      "selectModelRole",
      [
        {
          commandID: probeID,
          settingsVersion: 0,
          connectionID: crypto.randomUUID(),
          version: 1,
          role: "build",
          modelId: "owned-no-provider",
          confirmInference: true,
        },
      ],
      {},
      abort.signal,
    ),
  );
  await probeStarted.promise;
  abort.abort();
  await probe.catch(() => undefined);
  expect(probeSignal?.aborted).toBe(true);
  expect(commands.filter((id) => id === probeID)).toHaveLength(1);
});
