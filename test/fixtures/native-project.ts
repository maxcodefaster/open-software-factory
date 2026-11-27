import { createHash } from "node:crypto";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import type { renderSubstrateTemplate } from "../../apps/factory/src/runtime/substrate-template";
import template from "./native-project/actor-template.json";

const content = `${JSON.stringify(template, null, 2)}\n`;
export const nativeProjectTemplate = {
  path: ".factory/actor-template.json",
  content,
  sha256: createHash("sha256").update(content).digest("hex"),
};
export const nativeProjectDefinition = parseSubstrateProjectTemplate(content);
type Bootstrap = Parameters<typeof renderSubstrateTemplate>[2];
export function nativeProjectBootstrap(
  input: Omit<Partial<Bootstrap>, "assignment"> & {
    assignment?: Partial<Bootstrap["assignment"]>;
  } = {},
): Bootstrap {
  const assignment = {
    version: 1,
    runtimeAttemptId: "owned-native-attempt",
    generation: 1,
    controlUrl: "wss://factory.test/internal/runtime-connect",
    environmentVersion: 0,
    actorTemplatePath: nativeProjectTemplate.path,
    workspaceFolder: "/var/lib/factory/source/project",
    remoteWorkspaceFolder: "/var/lib/factory/source/project",
    repositoryUrl: "https://factory.test/source",
    repositoryIdentity: "owned-project",
    revision: "a".repeat(40),
    preserveWorkspace: true,
    channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
    processes: [],
  };
  return {
    source: { workspaceId: "owned-workspace", projectId: "owned-project" },
    parentToken: "owned-parent",
    childToken: "owned-child",
    factoryCA: "-----BEGIN CERTIFICATE-----\nowned-public-ca\n-----END CERTIFICATE-----\n",
    entryTokens: { work: "owned-work-entry", database: "owned-database-entry" },
    ...input,
    assignment: { ...assignment, ...input.assignment },
  };
}
