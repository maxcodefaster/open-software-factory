// Controlled command responses for the real sharing UI, not runtime or authority proof.
const owner = {
  workspaceID: "workspace-owner",
  ownerID: "developer-owner",
  name: "Owner",
  kind: "personal",
  collaborative: true,
};
const shared = {
  workspaceID: "workspace-shared",
  ownerID: "developer-peer",
  name: "Peer",
  kind: "personal",
  collaborative: true,
};
let complete = () => {};
const available = new Promise<void>((resolve) => {
  complete = resolve;
});
let members = [
  { userID: "observer", name: "Observer Developer", permission: "observe", version: 1 },
  {
    userID: "collaborator",
    name: "Collaborating Developer",
    permission: "collaborate",
    version: 2,
  },
];

export function releaseAvailableWorkspaces() {
  complete();
}
export async function getAvailableWorkspaces() {
  await available;
  return { ok: true as const, value: [{ ...owner }, { ...shared }] };
}
export async function getWorkspaceCollaboration({ data }: { data: [string] }) {
  const selected = data[0] === owner.workspaceID ? owner : shared;
  return { ok: true as const, value: { ...selected, participants: [] } };
}
export async function getWorkspaceSharing() {
  return {
    ok: true as const,
    value: { workspaceID: owner.workspaceID, members: members.map((row) => ({ ...row })) },
  };
}
export async function shareWorkspace({
  data,
}: {
  data: [{ userID: string; permission: string | null; expectedVersion: number }];
}) {
  const input = data[0];
  const current = members.find((row) => row.userID === input.userID);
  if (!current || current.version !== input.expectedVersion)
    throw Error("Observed sharing version differs");
  members = members.map((row) =>
    row === current
      ? { ...row, permission: input.permission ?? "private", version: row.version + 1 }
      : row,
  );
  return { ok: true as const, value: null };
}
export async function enableWorkspaceCollaboration() {
  throw Error("This UI fixture commissions no collaboration mutation");
}
export async function inspectWorkspaceSubmission() {
  throw Error("This UI fixture commissions no submission");
}
export async function submitWorkspace() {
  throw Error("This UI fixture commissions no submission");
}
