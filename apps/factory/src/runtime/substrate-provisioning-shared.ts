import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation as operationTable } from "#db/schema";
import { runtimeConnectorTokens, runtimeProjectEntryToken } from "#runtime-domain/identity";
import { nativeMetadata, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import type { SubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { prepareRuntimeRepository, runtimeSourceCapability } from "./git-http";
import { substrateTemplateSHA256 } from "./substrate";
import {
  type BoundNativeProvisioningFacts,
  boundNativeProvisioningChecks,
  boundNativeProvisioningKinds,
  dispatchProvisionResourceIn,
  provisionBoundNativeResources,
  rejectProvisionResourceIn,
  rememberProvisionResourceIn,
} from "./substrate-bound-provisioning";
import type { SubstrateWorkspaceConfiguration } from "./substrate-configuration";
import { renderSubstrateTemplate, substrateBootstrapCA } from "./substrate-template";

export type SubstrateDatabase = ReturnType<typeof createDatabase>;
export type SubstrateSQL = SubstrateDatabase["client"] | DatabaseTransaction;

export function substrateAtespaceName(attemptID: string) {
  return `fa-${attemptID.replaceAll("-", "")}`;
}

export async function withSubstrateAdvisoryLock<T>(
  database: SubstrateDatabase,
  lockKey: string,
  run: (sql: SubstrateDatabase["client"]) => Promise<T>,
): Promise<T> {
  const sql = database.coordination();
  try {
    await sql`SELECT pg_advisory_lock(hashtext(${lockKey}))`;
    return await run(sql);
  } finally {
    try {
      await sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}

export async function assertCurrentSubstrateDatabase(
  sql: SubstrateDatabase["client"],
  expectedDatabase: string,
  errorMessage: string,
) {
  const [currentDatabase] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (currentDatabase?.name !== expectedDatabase) throw new Error(errorMessage);
}

export async function readProjectEnvironmentIn(
  sql: SubstrateSQL,
  projectID: string,
  environmentName: "development" | "main-preview",
) {
  const [row] = await drizzleTransaction(sql)
    .select({ payload: operationTable.payload })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.kind, "environments.environment"),
        eq(operationTable.scopeType, "project"),
        eq(operationTable.scopeId, projectID),
        eq(
          operationTable.idempotencyKey,
          `environments.environment:${projectID}:${environmentName}`,
        ),
      ),
    );
  return row
    ? {
        version: Number(row.payload["version"] ?? 0),
        secretKey: typeof row.payload["secretKey"] === "string" ? row.payload["secretKey"] : null,
      }
    : undefined;
}

export function buildBoundSubstrateBase(
  config: SubstrateWorkspaceConfiguration,
  row: BoundNativeProvisioningFacts & { generation: number; templateSHA256: string },
  unconfirmedMessage: string,
) {
  if (!row.atespace || !row.template || !row.policy) throw new Error(unconfirmedMessage);
  return {
    deployment: config.deployment,
    database: config.database,
    projectID: config.projectID,
    generation: row.generation,
    connection: config.connection,
    connectorURL: config.connectorURL,
    profile: config.profile,
    runtime: config.runtime,
    workerSelector: config.workerSelector,
    egressHosts: config.egressHosts,
    ...(config.resources ? { resources: config.resources } : {}),
    atespaceUID: row.atespace.metadata.uid,
    templateUID: row.template.metadata.uid,
    templateVersion: row.template.metadata.version,
    templateSHA256: row.templateSHA256,
  };
}

export type SubstrateAssignmentChannel = {
  name: string;
  kind: string;
  target: string;
  healthPath?: string | undefined;
};
export type SubstrateAssignmentProcess = {
  name: string;
  label?: string | undefined;
  command: readonly string[];
  env?: Record<string, string | undefined> | undefined;
};

export function renderBoundSubstrateTemplate(options: {
  config: SubstrateWorkspaceConfiguration;
  secret: string;
  attemptID: string;
  generation: number;
  revision: string;
  actorTemplatePath: string;
  projectTemplate: { path: string; sha256: string };
  nativeProject: SubstrateProjectTemplate;
  environmentVersion: number;
  channels: SubstrateAssignmentChannel[];
  processes: SubstrateAssignmentProcess[];
  sourceWorkspaceID: string;
  branch?: string;
  sourceHandoff: boolean;
  inputStop?: { version: number; openCodeVersion: string };
  browserToolsImage?: string;
}) {
  const atespace = substrateAtespaceName(options.attemptID);
  const factoryOrigin = `https://${new URL(options.config.connectorURL).host}`;
  const repositoryURL = new URL(
    `/internal/runtime-source/${options.attemptID}/${runtimeSourceCapability(options.attemptID)}`,
    factoryOrigin,
  ).href;
  const tokens = runtimeConnectorTokens(options.secret, options.attemptID, options.generation);
  const bootstrap = {
    entryTokens: Object.fromEntries(
      options.nativeProject.containers.map(({ name }) => [
        name,
        runtimeProjectEntryToken(options.secret, options.attemptID, options.generation, name),
      ]),
    ),
    sourceHandoff: options.sourceHandoff,
    projectTemplate: {
      path: options.projectTemplate.path,
      sha256: options.projectTemplate.sha256,
    },
    ...(options.inputStop ? { inputStop: options.inputStop } : {}),
    assignment: {
      version: 1,
      runtimeAttemptId: options.attemptID,
      generation: options.generation,
      workspaceFolder: "/home/rootless/persist/project",
      remoteWorkspaceFolder: "/workspace/project",
      repositoryUrl: repositoryURL,
      repositoryIdentity: options.config.projectID,
      preserveWorkspace: true,
      revision: options.revision,
      actorTemplatePath: options.actorTemplatePath,
      controlUrl: options.config.connectorURL,
      connectorStateDir: "/home/rootless/persist/connector",
      channels: options.channels,
      processes: options.processes,
      environmentVersion: options.environmentVersion,
      ...(options.browserToolsImage ? { browserToolsImage: options.browserToolsImage } : {}),
    },
    source: {
      workspaceId: options.sourceWorkspaceID,
      projectId: options.config.projectID,
      revision: options.revision,
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
      repositoryUrl: repositoryURL,
      originUrl: repositoryURL,
    },
    parentToken: tokens.parent,
    childToken: tokens.child,
    factoryCA: substrateBootstrapCA(options.config.factoryCAFile),
  };
  return renderSubstrateTemplate(atespace, options.config, bootstrap, options.nativeProject);
}

const nativeResource = z.object({ metadata: nativeMetadata }).passthrough();
type NativeResource = z.infer<typeof nativeResource>;

function requireRetainedResourceIdentity(
  value: NativeResource,
  prior: NativeResource | null,
  attempted: Date | null,
  name: string,
  atespace?: string,
) {
  if (
    !attempted ||
    value.metadata.name !== name ||
    value.metadata.atespace !== atespace ||
    Date.parse(value.metadata.createTime) < attempted.getTime() ||
    (prior &&
      (prior.metadata.uid !== value.metadata.uid ||
        prior.metadata.version !== value.metadata.version))
  )
    throw new Error("Native provisioning resource differs from its original identity");
}

export async function verifyRetainedWorkspaceResources(
  editor: SubstrateCall,
  atespace: string,
  editorPrincipal: string,
  templateSHA256: string,
  original: BoundNativeProvisioningFacts,
) {
  for (const kind of boundNativeProvisioningKinds) {
    const method =
      kind === "atespace"
        ? "GetAtespace"
        : kind === "policy"
          ? "GetAtespaceAccessPolicy"
          : "GetActorTemplate";
    const request =
      kind === "atespace"
        ? { atespace: { name: atespace } }
        : kind === "policy"
          ? { atespace: { name: atespace }, name: "default" }
          : { actorTemplate: { atespace, name: "runtime" } };
    const actual = nativeResource.parse(await editor(method, request));
    requireRetainedResourceIdentity(
      actual,
      original[kind],
      original[`${kind}AttemptedAt`],
      kind === "atespace" ? atespace : kind === "policy" ? "default" : "runtime",
      kind === "template" ? atespace : undefined,
    );
    if (
      kind === "policy" &&
      !isDeepStrictEqual(actual["bindings"], [{ role: "editor", members: [editorPrincipal] }])
    )
      throw new Error("Native Editor grant differs from immutable provisioning intent");
    if (kind === "template" && substrateTemplateSHA256(actual) !== templateSHA256)
      throw new Error("Native ActorTemplate spec differs from immutable provisioning intent");
  }
}

export async function provisionAndPrepareBoundResources<T extends BoundNativeProvisioningFacts>(
  sql: SubstrateDatabase["client"],
  options: {
    label: "Workspace" | "isolated";
    atespace: string;
    editorPrincipal: string;
    template: ReturnType<typeof renderSubstrateTemplate>;
    templateSHA256: string;
    identity: Parameters<typeof dispatchProvisionResourceIn>[1];
    editor: SubstrateCall;
    owner: SubstrateCall;
    authorize(): Promise<unknown>;
    read(): Promise<T>;
    attemptID: string;
    repository: string;
    revision: string;
  },
): Promise<T> {
  const row = await provisionBoundNativeResources({
    label: options.label,
    checks: boundNativeProvisioningChecks(
      options.label,
      options.atespace,
      options.editorPrincipal,
      options.template,
      options.templateSHA256,
    ),
    editor: options.editor,
    owner: options.owner,
    authorize: options.authorize,
    read: options.read,
    dispatch: (kind) => dispatchProvisionResourceIn(sql, options.identity, kind),
    reject: (kind) => rejectProvisionResourceIn(sql, options.identity, kind),
    remember: (kind, value) => rememberProvisionResourceIn(sql, options.identity, kind, value),
  });
  if (options.repository.startsWith("file://"))
    await prepareRuntimeRepository(options.attemptID, options.repository, options.revision);
  return row;
}
