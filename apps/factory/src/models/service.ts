import type { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { createModelConnections } from "./connections";
import type { createModelSettingsController } from "./controller";
import { deploymentModelConnections } from "./deployment";
import { providerCatalogue } from "./native";

export function createModelService(dependencies: {
  settings: Pick<
    ReturnType<typeof createModelSettingsController>,
    "get" | "set" | "getInherited" | "setProject" | "setPersonal"
  >;
  connections: Pick<
    ReturnType<typeof createModelConnections>,
    "list" | "roles" | "get" | "save" | "selectRole"
  >;
  access: Pick<
    ReturnType<typeof createAccessController>,
    "requireSystemManager" | "requireProject"
  >;
  signingKey: string;
}) {
  const { settings, connections, access, signingKey } = dependencies;
  return {
    async get(userID: string) {
      // get() also serves internal admission. Its browser adapter must retain
      // the System Manager gate that used to live in authorizeAPI.
      await access.requireSystemManager(userID);
      return settings.get();
    },
    async set(userID: string, input: Parameters<typeof settings.set>[0]) {
      await access.requireSystemManager(userID);
      return settings.set(input, userID);
    },
    async inherited(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      return settings.getInherited(projectID, userID);
    },
    async setProject(
      userID: string,
      projectID: string,
      input: Parameters<typeof settings.setProject>[2],
    ) {
      await access.requireProject(userID, projectID);
      return settings.setProject(projectID, userID, input);
    },
    async setPersonal(
      userID: string,
      projectID: string,
      input: Parameters<typeof settings.setPersonal>[2],
    ) {
      await access.requireProject(userID, projectID);
      return settings.setPersonal(projectID, userID, input);
    },
    async catalogue(userID: string) {
      await access.requireSystemManager(userID);
      return {
        providers: await providerCatalogue(),
        connections: await connections.list(userID),
        roles: await connections.roles(userID),
        deployment: deploymentModelConnections(signingKey).map(
          ({ apiKey: _secret, ...metadata }) => metadata,
        ),
      };
    },
    async connection(userID: string, connectionID: string) {
      await access.requireSystemManager(userID);
      return connections.get(connectionID, userID);
    },
    async saveConnection(userID: string, input: Parameters<typeof connections.save>[1]) {
      await access.requireSystemManager(userID);
      return connections.save(userID, input);
    },
    async adoptDeployment(
      userID: string,
      input: { role: "planning" | "build"; commandID: string; version: number },
    ) {
      await access.requireSystemManager(userID);
      const configured = deploymentModelConnections(signingKey).find(
        (value) => value.role === input.role,
      );
      if (!configured?.configured || !configured.apiKey)
        throw new CommandError("conflict", "No deployment connection is configured for this role");
      return connections.save(userID, {
        commandID: input.commandID,
        connectionID: configured.connectionID,
        version: input.version,
        provider: configured.provider,
        endpoint: configured.endpoint,
        apiKey: configured.apiKey,
      });
    },
    async selectRole(
      userID: string,
      input: Parameters<typeof connections.selectRole>[1],
      signal: AbortSignal,
    ) {
      await access.requireSystemManager(userID);
      return connections.selectRole(userID, input, signal);
    },
  };
}
