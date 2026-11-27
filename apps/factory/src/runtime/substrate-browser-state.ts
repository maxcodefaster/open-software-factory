import { z } from "zod";
import type { createDatabase } from "#db/client";
import { nativeRuntime, substrateConnection } from "#runtime-kubernetes/substrate-control";

export type BrowserDatabase = ReturnType<typeof createDatabase>;

export type BrowserExecutionScope = {
  id: string;
  turnID: string;
  changeID: string;
  attemptID: string;
  generation: number;
  agentSessionID: string;
  ownerID: string;
};
export type BrowserExecutionAuthority = (send: (expiresAt: string) => void) => Promise<void>;

export const browserInstallation = z.strictObject({
  image: z.string().regex(/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/),
  routerURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  caFile: z.string().startsWith("/"),
  credentialFile: z.string().startsWith("/"),
});
export type BrowserInstallation = z.infer<typeof browserInstallation>;

export function configuredSubstrateBrowser() {
  return browserInstallation.parse({
    image: process.env["FACTORY_BROWSER_TOOLS_IMAGE"],
    routerURL: process.env["FACTORY_SUBSTRATE_ROUTER_URL"] ?? "wss://atenet-router.ate-system.svc",
    caFile:
      process.env["FACTORY_SUBSTRATE_ROUTER_CA_FILE"] ?? "/run/factory/substrate-control/ca.pem",
    credentialFile:
      process.env["FACTORY_SUBSTRATE_ROUTER_CREDENTIAL_FILE"] ??
      "/run/factory/substrate-control/credential-bundle.pem",
  });
}

export const parentInput = z.object({
  connection: substrateConnection,
  atespaceUID: z.uuid(),
  runtime: nativeRuntime,
  actorSelector: z.record(z.string(), z.string()),
});
const appInput = z.strictObject({
  name: z.string(),
  kind: z.literal("app"),
  target: z.url(),
  healthPath: z.string().optional(),
});
export const intentInput = z.strictObject({
  version: z.literal(1),
  parent: parentInput,
  parentActorUID: z.uuid(),
  installation: browserInstallation,
  apps: z.array(appInput).min(1).max(8),
  templateSHA256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const BROWSER_KIND = "runtime.browser";
export const BROWSER_SCOPE_TYPE = "build_browser_session";
export const browserIdempotencyKey = (atespace: string, actorName: string) =>
  `${BROWSER_KIND}:${atespace}:${actorName}`;
export const browserActiveKey = (actorUid: string) => `runtime.browser_uid:${actorUid}`;

export type NativeResourceState<Identity extends Record<string, string> = { uid: string }> =
  | { phase: "pending" }
  | { phase: "attempted"; attemptedAt: Date }
  | ({ phase: "confirmed"; attemptedAt: Date } & Identity)
  | { phase: "rejected"; attemptedAt: Date };

export type BrowserTemplateState = NativeResourceState<{ uid: string; version: string }>;
export type BrowserActorState = NativeResourceState<{ uid: string }>;

export type BrowserBinding = {
  sessionId: string;
  atespace: string;
  actorName: string;
  intent: z.infer<typeof intentInput>;
  cpuMilli: number;
  memoryMiB: number;
  template: BrowserTemplateState;
  actor: BrowserActorState;
  resumeAttemptedAt: Date | null;
  resumeConfirmedAt: Date | null;
  connectAttemptedAt: Date | null;
  actorDeletedAt: Date | null;
  templateDeletedAt: Date | null;
};

export type BrowserUpdatePatch =
  | { templateAttemptedAt: true }
  | { templateUid: string; templateVersion: string }
  | { templateRejected: true }
  | { actorAttemptedAt: true }
  | { actorUid: string }
  | { actorRejected: true }
  | { resumeAttemptedAt: true }
  | { resumeConfirmedAt: true }
  | { connectAttemptedAt: true }
  | { actorDeletedAt: true }
  | { templateDeletedAt: true };

export type BrowserUpdateMutation =
  | { kind: "noop" }
  | { kind: "timestamp"; field: string; activate?: boolean; close?: boolean }
  | { kind: "template-identity"; uid: string; version: string }
  | { kind: "actor-identity"; uid: string }
  | { kind: "reject"; field: "templateRejected" | "actorRejected" };

export const IMMUTABLE_BROWSER_ERROR =
  "Native Browser intent, identity and external outcomes are immutable";

export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Native Browser timestamp is malformed");
  return parsed;
}

export function sameBrowserScope(left: BrowserExecutionScope, right: BrowserExecutionScope) {
  return (
    ["id", "turnID", "changeID", "attemptID", "generation", "agentSessionID", "ownerID"] as const
  ).every((key) => left[key] === right[key]);
}

export function classifyTemplateState(payload: Record<string, unknown>): BrowserTemplateState {
  const attemptedAt = parseTimestamp(payload["templateAttemptedAt"]);
  if (!attemptedAt) return { phase: "pending" };
  if (payload["templateRejected"] === true) return { phase: "rejected", attemptedAt };
  const uid = typeof payload["templateUid"] === "string" ? payload["templateUid"] : null;
  const version =
    typeof payload["templateVersion"] === "string" ? payload["templateVersion"] : null;
  if (uid !== null && version !== null) return { phase: "confirmed", attemptedAt, uid, version };
  return { phase: "attempted", attemptedAt };
}

export function classifyActorState(
  payload: Record<string, unknown>,
  result: Record<string, unknown>,
): BrowserActorState {
  const attemptedAt = parseTimestamp(payload["actorAttemptedAt"]);
  if (!attemptedAt) return { phase: "pending" };
  if (payload["actorRejected"] === true) return { phase: "rejected", attemptedAt };
  const uid = typeof result["actorUid"] === "string" ? result["actorUid"] : null;
  if (uid !== null) return { phase: "confirmed", attemptedAt, uid };
  return { phase: "attempted", attemptedAt };
}

function requireStartableSession(sessionState: string) {
  if (sessionState !== "intended" && sessionState !== "active")
    throw new Error("Closing Browser cannot start native execution");
}

export function planBrowserUpdate(
  sessionState: string,
  payload: Record<string, unknown>,
  result: Record<string, unknown>,
  patch: BrowserUpdatePatch,
): BrowserUpdateMutation {
  if (sessionState === "closed") throw new Error(IMMUTABLE_BROWSER_ERROR);
  const template = classifyTemplateState(payload);
  const actor = classifyActorState(payload, result);

  if ("templateAttemptedAt" in patch) {
    requireStartableSession(sessionState);
    if (template.phase !== "pending") throw new Error(IMMUTABLE_BROWSER_ERROR);
    return { kind: "timestamp", field: "templateAttemptedAt" };
  }
  if ("actorAttemptedAt" in patch) {
    requireStartableSession(sessionState);
    if (actor.phase !== "pending") throw new Error(IMMUTABLE_BROWSER_ERROR);
    return { kind: "timestamp", field: "actorAttemptedAt" };
  }
  if ("resumeAttemptedAt" in patch) {
    requireStartableSession(sessionState);
    if (payload["resumeAttemptedAt"] != null) throw new Error(IMMUTABLE_BROWSER_ERROR);
    if (actor.phase !== "confirmed")
      throw new Error("Native Browser Resume requires confirmed Actor UID");
    return { kind: "timestamp", field: "resumeAttemptedAt" };
  }
  if ("connectAttemptedAt" in patch) {
    requireStartableSession(sessionState);
    if (payload["connectAttemptedAt"] != null) throw new Error(IMMUTABLE_BROWSER_ERROR);
    if (typeof payload["resumeConfirmedAt"] !== "string")
      throw new Error("Native Browser connect requires confirmed Resume");
    return { kind: "timestamp", field: "connectAttemptedAt", activate: true };
  }
  if ("resumeConfirmedAt" in patch) {
    if (payload["resumeConfirmedAt"] != null) throw new Error(IMMUTABLE_BROWSER_ERROR);
    if (typeof payload["resumeAttemptedAt"] !== "string")
      throw new Error("Native Browser Resume confirmation requires attempt");
    return { kind: "timestamp", field: "resumeConfirmedAt" };
  }
  if ("templateUid" in patch) {
    if (!/^[1-9][0-9]*$/.test(patch.templateVersion))
      throw new Error("Native Browser template identity requires unrejected attempt");
    if (template.phase === "pending" || template.phase === "rejected")
      throw new Error("Native Browser template identity requires unrejected attempt");
    if (template.phase === "confirmed") {
      if (template.uid === patch.templateUid && template.version === patch.templateVersion)
        return { kind: "noop" };
      throw new Error(IMMUTABLE_BROWSER_ERROR);
    }
    return { kind: "template-identity", uid: patch.templateUid, version: patch.templateVersion };
  }
  if ("actorUid" in patch) {
    if (template.phase !== "confirmed" || actor.phase === "pending" || actor.phase === "rejected")
      throw new Error("Native Browser Actor identity requires unrejected attempt");
    if (actor.phase === "confirmed") {
      if (actor.uid === patch.actorUid) return { kind: "noop" };
      throw new Error(IMMUTABLE_BROWSER_ERROR);
    }
    return { kind: "actor-identity", uid: patch.actorUid };
  }
  if ("templateRejected" in patch) {
    if (template.phase === "pending" || template.phase === "confirmed")
      throw new Error("Native Browser template rejection requires unconfirmed attempt");
    return { kind: "reject", field: "templateRejected" };
  }
  if ("actorRejected" in patch) {
    if (actor.phase === "pending" || actor.phase === "confirmed")
      throw new Error("Native Browser Actor rejection requires unconfirmed attempt");
    return { kind: "reject", field: "actorRejected" };
  }
  if (sessionState !== "closing")
    throw new Error("Native Browser deletion requires saved cleanup intent");
  const actorKind = "actorDeletedAt" in patch;
  const field = actorKind ? "actorDeletedAt" : "templateDeletedAt";
  const otherField = actorKind ? "templateDeletedAt" : "actorDeletedAt";
  const resource = actorKind ? actor : template;
  if (payload[field] != null) throw new Error(IMMUTABLE_BROWSER_ERROR);
  if (resource.phase === "attempted")
    throw new Error("Native Browser deletion requires confirmed identity");
  return { kind: "timestamp", field, close: payload[otherField] != null };
}
