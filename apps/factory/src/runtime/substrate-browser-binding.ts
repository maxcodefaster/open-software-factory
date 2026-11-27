import { isDeepStrictEqual } from "node:util";
import { and, eq, isNotNull, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import {
  buildBrowserSession,
  operation as operationTable,
  runtimeAttempt,
  substrateProvision,
} from "#db/schema";
import { systemContract } from "#system-contract/system-contract";
import { admitComputeIn } from "../usage/compute";
import type { RuntimeHub } from "./hub";
import { substrateTemplateSHA256 } from "./substrate";
import {
  BROWSER_KIND,
  BROWSER_SCOPE_TYPE,
  type BrowserBinding,
  type BrowserDatabase,
  type BrowserExecutionAuthority,
  type BrowserExecutionScope,
  type BrowserInstallation,
  type BrowserUpdatePatch,
  browserActiveKey,
  browserIdempotencyKey,
  browserInstallation,
  classifyActorState,
  classifyTemplateState,
  configuredSubstrateBrowser,
  IMMUTABLE_BROWSER_ERROR,
  intentInput,
  parentInput,
  parseTimestamp,
  planBrowserUpdate,
  sameBrowserScope,
} from "./substrate-browser-state";
import {
  renderSubstrateBrowserTemplate,
  substrateBrowserResources as resources,
} from "./substrate-browser-template";
import type { SubstrateInstallationConfiguration } from "./substrate-workspaces";

export async function readSavedBrowserBinding(
  database: BrowserDatabase,
  installation: SubstrateInstallationConfiguration,
  scope: BrowserExecutionScope,
): Promise<BrowserBinding | undefined> {
  const [row] = await database.db
    .select({
      id: operationTable.id,
      payload: operationTable.payload,
      result: operationTable.result,
    })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.id, scope.id),
        eq(operationTable.kind, BROWSER_KIND),
        eq(operationTable.scopeType, BROWSER_SCOPE_TYPE),
      ),
    );
  if (!row) return undefined;
  const [session] = await database.db
    .select()
    .from(buildBrowserSession)
    .where(eq(buildBrowserSession.id, scope.id));
  if (
    !session ||
    !sameBrowserScope(scope, {
      id: session.id,
      turnID: session.turnId,
      changeID: session.changeId,
      attemptID: session.runtimeAttemptId,
      generation: session.generation,
      agentSessionID: session.agentSessionId,
      ownerID: session.ownerId,
    })
  )
    throw new Error("Native Browser Session scope changed");
  const payload = row.payload;
  const result = row.result ?? {};
  const atespace = payload["atespace"];
  const actorName = payload["actorName"];
  const cpuMilli = payload["cpuMilli"];
  const memoryMiB = payload["memoryMiB"];
  if (
    typeof atespace !== "string" ||
    typeof actorName !== "string" ||
    typeof cpuMilli !== "number" ||
    typeof memoryMiB !== "number"
  )
    throw new Error("Native Browser binding payload is malformed");
  const intent = intentInput.parse(payload["intent"]);
  if (
    !isDeepStrictEqual(intent.parent.connection, installation.connection) ||
    !isDeepStrictEqual(intent.parent.runtime, installation.runtime)
  )
    throw new Error("Native Browser installation trust/profile changed");
  return {
    sessionId: row.id,
    atespace,
    actorName,
    intent,
    cpuMilli,
    memoryMiB,
    template: classifyTemplateState(payload),
    actor: classifyActorState(payload, result),
    resumeAttemptedAt: parseTimestamp(payload["resumeAttemptedAt"]),
    resumeConfirmedAt: parseTimestamp(payload["resumeConfirmedAt"]),
    connectAttemptedAt: parseTimestamp(payload["connectAttemptedAt"]),
    actorDeletedAt: parseTimestamp(payload["actorDeletedAt"]),
    templateDeletedAt: parseTimestamp(payload["templateDeletedAt"]),
  };
}

export async function requireSavedBrowserBinding(
  database: BrowserDatabase,
  installation: SubstrateInstallationConfiguration,
  scope: BrowserExecutionScope,
) {
  const row = await readSavedBrowserBinding(database, installation, scope);
  if (!row) throw new Error("Native Browser binding was not retained");
  return row;
}

export async function updateBrowserBinding(
  database: BrowserDatabase,
  scope: BrowserExecutionScope,
  patch: BrowserUpdatePatch,
) {
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const [session] = await db
      .select({ state: buildBrowserSession.state })
      .from(buildBrowserSession)
      .where(eq(buildBrowserSession.id, scope.id))
      .for("update");
    if (!session) throw new Error("Native Browser requires its retained Session");
    if (session.state === "closed") throw new Error(IMMUTABLE_BROWSER_ERROR);
    const whereIdentity = and(
      eq(operationTable.id, scope.id),
      eq(operationTable.kind, BROWSER_KIND),
      eq(operationTable.scopeType, BROWSER_SCOPE_TYPE),
    );
    const [existing] = await db
      .select({ payload: operationTable.payload, result: operationTable.result })
      .from(operationTable)
      .where(whereIdentity)
      .for("update");
    if (!existing) throw new Error("Native Browser binding was not retained");
    const mutation = planBrowserUpdate(
      session.state,
      existing.payload,
      existing.result ?? {},
      patch,
    );
    switch (mutation.kind) {
      case "noop":
        return;
      case "timestamp":
        await db
          .update(operationTable)
          .set({
            ...(mutation.activate ? { state: "active" } : {}),
            ...(mutation.close ? { state: "closed", completedAt: query`clock_timestamp()` } : {}),
            payload: query`${operationTable.payload} || jsonb_build_object(${mutation.field}::text, clock_timestamp()::text)`,
            updatedAt: query`clock_timestamp()`,
          })
          .where(whereIdentity);
        return;
      case "template-identity":
        await db
          .update(operationTable)
          .set({
            payload: query`${operationTable.payload} || jsonb_build_object('templateUid', ${mutation.uid}::text, 'templateVersion', ${mutation.version}::text)`,
            updatedAt: query`clock_timestamp()`,
          })
          .where(whereIdentity);
        return;
      case "actor-identity":
        await db
          .update(operationTable)
          .set({
            activeKey: browserActiveKey(mutation.uid),
            result: { actorUid: mutation.uid },
            updatedAt: query`clock_timestamp()`,
          })
          .where(whereIdentity);
        return;
      case "reject":
        await db
          .update(operationTable)
          .set({
            payload: query`${operationTable.payload} || jsonb_build_object(${mutation.field}::text, true)`,
            updatedAt: query`clock_timestamp()`,
          })
          .where(whereIdentity);
        return;
    }
  });
}

export async function bindBrowserSession(
  deps: {
    database: BrowserDatabase;
    hub: RuntimeHub;
    installation: SubstrateInstallationConfiguration;
    browser?: BrowserInstallation | undefined;
    token: (id: string) => string;
  },
  scope: BrowserExecutionScope,
  authorize: BrowserExecutionAuthority,
) {
  const previous = await readSavedBrowserBinding(deps.database, deps.installation, scope);
  if (previous) return previous;
  await authorize(() => {});
  await deps.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const [session] = await db
      .select({ state: buildBrowserSession.state })
      .from(buildBrowserSession)
      .where(eq(buildBrowserSession.id, scope.id))
      .for("update");
    if (!session || (session.state !== "intended" && session.state !== "active"))
      throw new Error("Native Browser requires its current confirmed Parent binding");
    const [parent] = await db
      .select({
        atespace: runtimeAttempt.atespace,
        uid: runtimeAttempt.actorUid,
        intent: runtimeAttempt.bindingIntent,
        projectID: runtimeAttempt.projectId,
        workspaceIntent: substrateProvision.intent,
      })
      .from(runtimeAttempt)
      .innerJoin(
        substrateProvision,
        and(
          eq(substrateProvision.ownerId, runtimeAttempt.workspaceId),
          eq(substrateProvision.kind, "workspace"),
          eq(substrateProvision.generation, runtimeAttempt.generation),
        ),
      )
      .where(
        and(
          eq(runtimeAttempt.id, scope.attemptID),
          eq(runtimeAttempt.generation, scope.generation),
          eq(runtimeAttempt.state, "ready"),
          isNull(runtimeAttempt.stopIntendedAt),
          isNotNull(runtimeAttempt.atespace),
          isNull(runtimeAttempt.deleteIntendedAt),
          isNull(runtimeAttempt.deletedAt),
        ),
      );
    if (!parent?.uid || !parent.atespace)
      throw new Error("Native Browser requires its confirmed Workspace Actor");
    const frozen = parentInput.parse(parent.intent);
    if (
      !isDeepStrictEqual(frozen.connection, deps.installation.connection) ||
      !isDeepStrictEqual(frozen.runtime, deps.installation.runtime)
    )
      throw new Error("Native Browser Parent belongs to another installation");
    const contract = systemContract.parse(
      z.object({ systemContract }).parse(parent.workspaceIntent).systemContract,
    );
    const apps = contract.apps.map((app) => ({
      name: app.id === contract.primaryApp ? "app" : `app-${app.id}`,
      kind: "app" as const,
      target: `http://127.0.0.1:${app.port}`,
      healthPath: app.healthPath,
    }));
    if (!apps.every((app) => deps.hub.hasAppChannel(scope.attemptID, app.name)))
      throw new Error("Native Browser requires the current declared App channels");
    const selected = browserInstallation.parse(deps.browser ?? configuredSubstrateBrowser());
    const rendered = renderSubstrateBrowserTemplate({
      atespace: parent.atespace,
      image: selected.image,
      workerSelector: frozen.actorSelector,
      runtimeAttemptId: scope.attemptID,
      generation: scope.generation,
      sessionId: scope.id,
      turnId: scope.turnID,
      agentSessionId: scope.agentSessionID,
      ownerId: scope.ownerID,
      token: deps.token(scope.id),
      apps,
    });
    await admitComputeIn(sql, parent.projectID, resources);
    await db
      .insert(operationTable)
      .values({
        id: scope.id,
        kind: BROWSER_KIND,
        scopeType: BROWSER_SCOPE_TYPE,
        scopeId: scope.id,
        idempotencyKey: browserIdempotencyKey(parent.atespace, rendered.metadata.name),
        activeKey: null,
        state: "intended",
        payload: {
          atespace: parent.atespace,
          actorName: rendered.metadata.name,
          ...resources,
          intent: {
            version: 1,
            parent: frozen,
            parentActorUID: parent.uid,
            installation: selected,
            apps,
            templateSHA256: substrateTemplateSHA256(rendered),
          },
          templateAttemptedAt: null,
          templateUid: null,
          templateVersion: null,
          templateRejected: false,
          actorAttemptedAt: null,
          actorRejected: false,
          resumeAttemptedAt: null,
          resumeConfirmedAt: null,
          connectAttemptedAt: null,
          actorDeletedAt: null,
          templateDeletedAt: null,
        },
        result: null,
        completedAt: null,
      })
      .onConflictDoNothing();
  });
  const row = await readSavedBrowserBinding(deps.database, deps.installation, scope);
  if (!row) throw new Error("Native Browser intent was not retained");
  return row;
}
