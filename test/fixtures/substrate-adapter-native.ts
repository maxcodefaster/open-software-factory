import { createHash } from "node:crypto";
import { runtimeConnectorTokens, runtimeProjectEntryToken } from "#runtime-domain/identity";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { renderSubstrateTemplate } from "../../apps/factory/src/runtime/substrate-template";
import { nativeProjectBootstrap } from "./native-project";

// Pure declaration for the explicit native adapter proof. Production entrypoints,
// Project admission and native lifecycle are not replaced with fixture launchers.
export function nativeAdapterTemplate(input: {
  secret: string;
  atespace: string;
  attemptID: string;
  workspaceID: string;
  projectID: string;
  revision: string;
  branch: string;
  connectorURL: string;
  repositoryURL: string;
  factoryCA: string;
  workloadImage: string;
  workerSelector: Record<string, string>;
  projectTemplateContent: string;
}) {
  const project = parseSubstrateProjectTemplate(input.projectTemplateContent);
  const projectTemplate = {
    path: ".factory/actor-template.json",
    content: input.projectTemplateContent,
    sha256: createHash("sha256").update(input.projectTemplateContent).digest("hex"),
  };
  const tokens = runtimeConnectorTokens(input.secret, input.attemptID, 1);
  const bootstrap = nativeProjectBootstrap({
    sourceHandoff: false,
    projectTemplate: { path: projectTemplate.path, sha256: projectTemplate.sha256 },
    assignment: {
      runtimeAttemptId: input.attemptID,
      repositoryIdentity: input.projectID,
      repositoryUrl: input.repositoryURL,
      revision: input.revision,
      controlUrl: input.connectorURL,
      environmentVersion: 0,
    },
    source: {
      workspaceId: input.workspaceID,
      projectId: input.projectID,
      repositoryUrl: input.repositoryURL,
      originUrl: input.repositoryURL,
      revision: input.revision,
      branch: input.branch,
    },
    parentToken: tokens.parent,
    childToken: tokens.child,
    factoryCA: input.factoryCA,
    entryTokens: Object.fromEntries(
      project.containers.map(({ name }) => [
        name,
        runtimeProjectEntryToken(input.secret, input.attemptID, 1, name),
      ]),
    ),
  });
  const template = renderSubstrateTemplate(
    input.atespace,
    { workloadImage: input.workloadImage, workerSelector: input.workerSelector },
    bootstrap,
    project,
  );
  // This lane deliberately proves cold reconnect. Production still prefers MEMORY;
  // native MEMORY/process continuity belongs to its separate qualification lane.
  template.snapshotConfig.preferredFidelity = "SNAPSHOT_FIDELITY_ROOTFS";
  return { template, projectTemplate };
}
