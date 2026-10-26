import { createHash } from "node:crypto";

export const developmentWorkspaceKinds = ["personal", "ticket"] as const;
export type DevelopmentWorkspaceKind = (typeof developmentWorkspaceKinds)[number];

function uuidFromDigest(digest: Buffer) {
  const bytes = Buffer.from(digest);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function identity(kind: DevelopmentWorkspaceKind, ownerID: string) {
  const digest = createHash("sha256")
    .update(`factory-development-workspace-v1:${kind}:${ownerID}`)
    .digest();
  const workspaceID = uuidFromDigest(digest);
  return {
    workspaceID,
  };
}

export function personalWorkspaceIdentity(projectID: string, userID: string) {
  return identity("personal", `${projectID}:${userID}`);
}

export function ticketWorkspaceIdentity(changeID: string) {
  return identity("ticket", changeID);
}
