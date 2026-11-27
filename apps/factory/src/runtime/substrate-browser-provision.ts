import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  nativeActor,
  nativeMetadata,
  type SubstrateCall,
} from "#runtime-kubernetes/substrate-control";
import type { RuntimeHub } from "./hub";
import { substrateTemplateSHA256 } from "./substrate";
import {
  absentBoundNativeResource,
  boundNativeCreateRejected,
} from "./substrate-bound-provisioning";
import { requireSavedBrowserBinding, updateBrowserBinding } from "./substrate-browser-binding";
import type {
  BrowserBinding,
  BrowserDatabase,
  BrowserExecutionAuthority,
  BrowserExecutionScope,
  BrowserInstallation,
} from "./substrate-browser-state";
import { renderSubstrateBrowserTemplate } from "./substrate-browser-template";
import type { SubstrateInstallationConfiguration } from "./substrate-workspaces";

export type BrowserProvisionDeps = {
  database: BrowserDatabase;
  hub: RuntimeHub;
  installation: SubstrateInstallationConfiguration;
  browser?: BrowserInstallation | undefined;
  call: SubstrateCall;
  token: (id: string) => string;
};

export function renderVerifiedBrowserTemplate(
  scope: BrowserExecutionScope,
  row: BrowserBinding,
  token: (id: string) => string,
) {
  const value = renderSubstrateBrowserTemplate({
    atespace: row.atespace,
    image: row.intent.installation.image,
    workerSelector: row.intent.parent.actorSelector,
    runtimeAttemptId: scope.attemptID,
    generation: scope.generation,
    sessionId: scope.id,
    turnId: scope.turnID,
    agentSessionId: scope.agentSessionID,
    ownerId: scope.ownerID,
    token: token(scope.id),
    apps: row.intent.apps,
  });
  if (substrateTemplateSHA256(value) !== row.intent.templateSHA256)
    throw new Error("Native Browser template differs from its immutable intent");
  return value;
}

export async function verifyBrowserAtespace(
  call: SubstrateCall,
  row: BrowserBinding,
  allowAbsent = false,
) {
  const value = await absentBoundNativeResource(call, "GetAtespace", {
    atespace: { name: row.atespace },
  });
  if (!value) {
    if (allowAbsent) return false;
    throw new Error("Native Browser Atespace is absent");
  }
  const metadata = nativeMetadata.parse(
    z.object({ metadata: nativeMetadata }).parse(value).metadata,
  );
  if (metadata.name !== row.atespace || metadata.uid !== row.intent.parent.atespaceUID)
    throw new Error("Native Browser Atespace was replaced");
  return true;
}

export function verifyOriginalTemplate(value: unknown, row: BrowserBinding) {
  const result = z.object({ metadata: nativeMetadata }).passthrough().parse(value);
  if (
    row.template.phase === "pending" ||
    result.metadata.atespace !== row.atespace ||
    result.metadata.name !== row.actorName ||
    Date.parse(result.metadata.createTime) < row.template.attemptedAt.getTime() ||
    (row.template.phase === "confirmed" &&
      (result.metadata.uid !== row.template.uid ||
        result.metadata.version !== row.template.version)) ||
    substrateTemplateSHA256(result) !== row.intent.templateSHA256
  )
    throw new Error("Native Browser template differs from its original identity");
  return result;
}

export function verifyOriginalActor(value: unknown, row: BrowserBinding) {
  const result = nativeActor.parse(value);
  if (
    row.actor.phase === "pending" ||
    result.metadata.atespace !== row.atespace ||
    result.metadata.name !== row.actorName ||
    (row.actor.phase === "confirmed" && result.metadata.uid !== row.actor.uid) ||
    Date.parse(result.metadata.createTime) < row.actor.attemptedAt.getTime() ||
    result.actorTemplate.atespace !== row.atespace ||
    result.actorTemplate.name !== row.actorName ||
    result.sourceTag ||
    !isDeepStrictEqual(result.workerSelector?.matchLabels, row.intent.parent.actorSelector) ||
    (result.status.workerAssignment &&
      !isDeepStrictEqual(result.status.workerAssignment.sandboxRuntime, row.intent.parent.runtime))
  )
    throw new Error("Native Browser Actor differs from its original identity");
  if (result.status.state === "ACTOR_STATE_RUNNING" && !result.status.workerAssignment)
    throw new Error("Native Browser running identity is unconfirmed");
  return result;
}

export async function admitBrowserCall<T>(
  authorize: BrowserExecutionAuthority,
  send: () => Promise<T>,
) {
  let response: Promise<T> | undefined;
  await authorize(() => {
    if (response) throw new Error("Native Browser operation was already dispatched");
    response = send();
    void response.catch(() => {});
  });
  if (!response) throw new Error("Native Browser dispatch was not admitted");
  return response;
}

export async function createBrowserResource(
  deps: BrowserProvisionDeps,
  scope: BrowserExecutionScope,
  row: BrowserBinding,
  kind: "template" | "actor",
  authorize: BrowserExecutionAuthority,
  signal?: AbortSignal,
) {
  const templateKind = kind === "template";
  const state = templateKind ? row.template : row.actor;
  if (state.phase === "rejected")
    throw new Error("Rejected native Browser Create cannot adopt a resource");
  const ref = { atespace: row.atespace, name: row.actorName };
  const getMethod = templateKind ? "GetActorTemplate" : "GetActor";
  const request = templateKind ? { actorTemplate: ref } : { actor: ref };
  if (state.phase === "pending") {
    const declaration = templateKind
      ? renderVerifiedBrowserTemplate(scope, row, deps.token)
      : undefined;
    if (await absentBoundNativeResource(deps.call, getMethod, request))
      throw new Error("Preexisting native Browser resource was not adopted");
    signal?.throwIfAborted();
    await updateBrowserBinding(
      deps.database,
      scope,
      templateKind ? { templateAttemptedAt: true } : { actorAttemptedAt: true },
    );
    row = await requireSavedBrowserBinding(deps.database, deps.installation, scope);
    let dispatched = false;
    try {
      const created = await admitBrowserCall(authorize, () => {
        signal?.throwIfAborted();
        dispatched = true;
        return deps.call(
          templateKind ? "CreateActorTemplate" : "CreateActor",
          templateKind
            ? { actorTemplate: declaration }
            : {
                actor: {
                  metadata: ref,
                  actorTemplate: ref,
                  workerSelector: { matchLabels: row.intent.parent.actorSelector },
                },
              },
        );
      });
      if (templateKind) {
        const value = verifyOriginalTemplate(created, row);
        await updateBrowserBinding(deps.database, scope, {
          templateUid: value.metadata.uid,
          templateVersion: value.metadata.version,
        });
      } else {
        const value = verifyOriginalActor(created, row);
        await updateBrowserBinding(deps.database, scope, { actorUid: value.metadata.uid });
      }
      row = await requireSavedBrowserBinding(deps.database, deps.installation, scope);
    } catch (cause) {
      if (!dispatched || boundNativeCreateRejected(cause))
        await updateBrowserBinding(
          deps.database,
          scope,
          templateKind ? { templateRejected: true } : { actorRejected: true },
        );
      throw cause;
    }
  }
  const observed = await absentBoundNativeResource(deps.call, getMethod, request);
  if (!observed) throw new Error("Native Browser Create outcome is unknown; do not repeat it");
  if (templateKind) {
    const value = verifyOriginalTemplate(observed, row);
    await updateBrowserBinding(deps.database, scope, {
      templateUid: value.metadata.uid,
      templateVersion: value.metadata.version,
    });
  } else {
    const value = verifyOriginalActor(observed, row);
    await updateBrowserBinding(deps.database, scope, { actorUid: value.metadata.uid });
  }
  return await requireSavedBrowserBinding(deps.database, deps.installation, scope);
}
