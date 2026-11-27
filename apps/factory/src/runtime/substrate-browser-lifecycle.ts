import { buildBrowserResultInput } from "#conversation-domain/browser-tools";
import type { connectSubstrateBrowser } from "#runtime-kubernetes/substrate-browser-client";
import type { RuntimeHub } from "./hub";
import { absentBoundNativeResource } from "./substrate-bound-provisioning";
import {
  bindBrowserSession,
  readSavedBrowserBinding,
  requireSavedBrowserBinding,
  updateBrowserBinding,
} from "./substrate-browser-binding";
import {
  admitBrowserCall,
  type BrowserProvisionDeps,
  createBrowserResource,
  verifyBrowserAtespace,
  verifyOriginalActor,
  verifyOriginalTemplate,
} from "./substrate-browser-provision";
import {
  type BrowserBinding,
  type BrowserExecutionAuthority,
  type BrowserExecutionScope,
  sameBrowserScope,
} from "./substrate-browser-state";

export type BrowserConnection = {
  scope: BrowserExecutionScope;
  actorUID: string;
  client: Awaited<ReturnType<typeof connectSubstrateBrowser>>;
};

export type BrowserLifecycleDeps = BrowserProvisionDeps & {
  connect: typeof connectSubstrateBrowser;
};

function createBrowserRelay(
  hub: RuntimeHub,
  scope: BrowserExecutionScope,
  row: BrowserBinding,
  authorize: BrowserExecutionAuthority,
) {
  const fixedScope = { ...scope };
  return {
    async openAppSocket(app: string, request: Request, path: string) {
      const declared = row.intent.apps.find((value) => value.name === app);
      if (!declared) throw new Error("Native Browser App is not declared");
      return hub.openBrowserAppSocket(
        fixedScope.attemptID,
        app,
        request,
        path,
        {
          actorUID: row.intent.parentActorUID,
          generation: fixedScope.generation,
          target: declared.target,
        },
        async (send) =>
          authorize(() => {
            request.signal.throwIfAborted();
            send();
          }),
      );
    },
    async requestApp(app: string, request: Request, path: string) {
      if (!row.intent.apps.some((value) => value.name === app))
        throw new Error("Native Browser App is not declared");
      return hub.requestBrowserApp(fixedScope.attemptID, app, request, path, async (send) =>
        authorize(() => {
          request.signal.throwIfAborted();
          send();
        }),
      );
    },
    async inspect(app: string, signal: AbortSignal) {
      if (!row.intent.apps.some((value) => value.name === app))
        throw new Error("Native Browser App is not declared");
      let pending: ReturnType<RuntimeHub["parentOperation"]> | undefined;
      await authorize((expiresAt) => {
        signal.throwIfAborted();
        if (pending) throw new Error("Native Browser Source observation was already dispatched");
        pending = hub.parentOperation(fixedScope.attemptID, {
          operationId: crypto.randomUUID(),
          action: "browser-inspection",
          runtimeAttemptId: fixedScope.attemptID,
          generation: fixedScope.generation,
          data: JSON.stringify({
            sessionId: fixedScope.id,
            turnId: fixedScope.turnID,
            agentSessionId: fixedScope.agentSessionID,
            ownerId: fixedScope.ownerID,
            expiresAt,
            call: { name: "browser-inspection", arguments: { app } },
          }),
        });
        void pending.catch(() => {});
      });
      if (!pending) throw new Error("Native Browser Source observation was not admitted");
      const response = await pending;
      signal.throwIfAborted();
      const context = buildBrowserResultInput.shape.structuredContent
        .unwrap()
        .parse(JSON.parse(response.data ?? ""));
      if (
        context.sessionId !== fixedScope.id ||
        context.turnId !== fixedScope.turnID ||
        context.runtimeAttemptId !== fixedScope.attemptID ||
        context.generation !== fixedScope.generation ||
        context.app !== app
      )
        throw new Error("Native Browser Source observation changed execution scope");
      return context;
    },
  };
}

export async function prepareBrowserConnection(
  deps: BrowserLifecycleDeps,
  connections: Map<string, BrowserConnection>,
  scope: BrowserExecutionScope,
  authorize: BrowserExecutionAuthority,
  signal?: AbortSignal,
) {
  const existing = connections.get(scope.id);
  if (existing) {
    if (!sameBrowserScope(existing.scope, scope)) throw new Error("Native Browser owner changed");
    return;
  }
  let row = await bindBrowserSession(deps, scope, authorize);
  if (row.actorDeletedAt || row.templateDeletedAt || row.connectAttemptedAt)
    throw new Error("Native Browser requires original cleanup; never reconnect or replay");
  await verifyBrowserAtespace(deps.call, row);
  row = await createBrowserResource(deps, scope, row, "template", authorize, signal);
  row = await createBrowserResource(deps, scope, row, "actor", authorize, signal);
  const ref = { atespace: row.atespace, name: row.actorName };
  let actor = verifyOriginalActor(await deps.call("GetActor", { actor: ref }), row);
  if (!row.resumeAttemptedAt) {
    signal?.throwIfAborted();
    await updateBrowserBinding(deps.database, scope, { resumeAttemptedAt: true });
    // Pinned official ResumeActorRequest accepts only the Actor ref;
    // UID/version preconditions exist on Delete, not on Resume.
    await admitBrowserCall(authorize, () => deps.call("ResumeActor", { actor: ref }));
    row = await requireSavedBrowserBinding(deps.database, deps.installation, scope);
  }
  actor = verifyOriginalActor(await deps.call("GetActor", { actor: ref }), row);
  if (actor.status.state !== "ACTOR_STATE_RUNNING")
    throw new Error("Native Browser Resume is unconfirmed; its RPC was not repeated");
  if (!row.resumeConfirmedAt)
    await updateBrowserBinding(deps.database, scope, { resumeConfirmedAt: true });
  // A restart never adopts an old control socket. This durable attempt
  // makes even a lost first handshake require independent native cleanup.
  await updateBrowserBinding(deps.database, scope, { connectAttemptedAt: true });
  row = await requireSavedBrowserBinding(deps.database, deps.installation, scope);
  const { image: _image, ...transport } = row.intent.installation;
  const client = await deps.connect(
    {
      ...transport,
      atespace: row.atespace,
      actorName: row.actorName,
      actorUID: actor.metadata.uid,
      runtimeAttemptId: scope.attemptID,
      generation: scope.generation,
      scope: {
        sessionId: scope.id,
        turnId: scope.turnID,
        agentSessionId: scope.agentSessionID,
        ownerId: scope.ownerID,
      },
      token: deps.token(scope.id),
      apps: row.intent.apps.map((app) => app.name),
    },
    createBrowserRelay(deps.hub, scope, row, authorize),
    signal,
    async (send) => authorize(() => send()),
  );
  connections.set(scope.id, { scope: { ...scope }, actorUID: actor.metadata.uid, client });
}

export async function closeBrowserResources(
  deps: BrowserProvisionDeps,
  scope: BrowserExecutionScope,
) {
  let row = await readSavedBrowserBinding(deps.database, deps.installation, scope);
  if (!row) return; // No native intent: no native Create was ever dispatched.
  await verifyBrowserAtespace(deps.call, row, true);
  for (const kind of ["actor", "template"] as const) {
    const actorKind = kind === "actor";
    if (actorKind ? row.actorDeletedAt : row.templateDeletedAt) continue;
    const state = actorKind ? row.actor : row.template;
    if (state.phase === "attempted" || state.phase === "confirmed") {
      const ref = { atespace: row.atespace, name: row.actorName };
      const request = actorKind ? { actor: ref } : { actorTemplate: ref };
      const getMethod = actorKind ? "GetActor" : "GetActorTemplate";
      const observed = await absentBoundNativeResource(deps.call, getMethod, request);
      if (observed) {
        if (actorKind && state.phase === "attempted") {
          verifyOriginalTemplate(await deps.call("GetActorTemplate", { actorTemplate: ref }), row);
        }
        const original = actorKind
          ? verifyOriginalActor(observed, row)
          : verifyOriginalTemplate(observed, row);
        await updateBrowserBinding(
          deps.database,
          scope,
          actorKind
            ? { actorUid: original.metadata.uid }
            : {
                templateUid: original.metadata.uid,
                templateVersion: original.metadata.version,
              },
        );
        await deps.call(actorKind ? "DeleteActor" : "DeleteActorTemplate", {
          ...request,
          options: { uid: original.metadata.uid, version: original.metadata.version },
        });
        if (await absentBoundNativeResource(deps.call, getMethod, request))
          throw new Error("Native Browser Delete has not completed");
      } else if (state.phase === "attempted")
        throw new Error(
          "Unknown native Browser Create has no confirmed UID; cleanup remains unconfirmed",
        );
    }
    await updateBrowserBinding(
      deps.database,
      scope,
      actorKind ? { actorDeletedAt: true } : { templateDeletedAt: true },
    );
    row = await requireSavedBrowserBinding(deps.database, deps.installation, scope);
  }
}
