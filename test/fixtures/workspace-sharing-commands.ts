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
const sourceAccessTicket = {
  workspaceID: "workspace-source-access-ticket",
  ownerID: null,
  name: "Source access Ticket",
  kind: "ticket",
  collaborative: false,
};
const sourceAccessChangeID = "10000000-0000-4000-8000-000000000004";
const sourceAccessParams = () => new URLSearchParams(location.search);
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
  return {
    ok: true as const,
    value: [
      { ...owner },
      { ...shared },
      ...(sourceAccessParams().get("workspace") === sourceAccessTicket.workspaceID
        ? [{ ...sourceAccessTicket }]
        : []),
    ],
  };
}
export async function getWorkspaceCollaboration({ data }: { data: [string] }) {
  const selected =
    data[0] === sourceAccessTicket.workspaceID
      ? sourceAccessTicket
      : data[0] === owner.workspaceID
        ? owner
        : shared;
  return {
    ok: true as const,
    value: { ...selected, permission: "collaborate" as const, participants: [] },
  };
}
export async function getWorkspaceSource({ data }: { data: [string] }) {
  const access = sourceAccessParams().get("source-access");
  if (access === "unknown") throw Error("The file access check timed out.");
  return {
    ok: true as const,
    value: {
      workspaceID: access === "mismatch" ? shared.workspaceID : data[0],
      state: access === "unavailable" ? ("preparing" as const) : ("ready" as const),
      failure:
        access === "unavailable"
          ? "The current Source owner is frozen or unavailable. Compute was not started; keep your editor buffer."
          : null,
    },
  };
}
export async function getRuntimeAttempts() {
  return {
    ok: true as const,
    value: {
      attempts: [
        {
          id: "source-access-attempt",
          workspaceId: sourceAccessTicket.workspaceID,
          projectId: "owned-project",
          changeId: sourceAccessChangeID,
          state: sourceAccessParams().get("compute-access") ?? "ready",
        },
      ],
    },
  };
}
export async function getChangeWriterStatus({ data }: { data: [string] }) {
  if (data[0] !== sourceAccessChangeID) throw Error("Different Ticket writing authority queried.");
  const state = sourceAccessParams().get("writer-access") ?? "human";
  if (state === "unknown")
    throw Error("Editing status unavailable. Writing authority has not changed.");
  return {
    ok: true as const,
    value: {
      state,
      canWrite: state === "human" && !sourceAccessParams().has("writer-denied"),
      stopPending: sourceAccessParams().has("writer-stop-pending"),
      actor: sourceAccessParams().has("writer-settled")
        ? { kind: "agent", user: null, delegated: false, workState: "completed" }
        : null,
    },
  };
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
