import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import type { SourceHostManager } from "./substrate-source-host";
import {
  classifySourceLease,
  isFrozenLease,
  readSourceLease,
  readSourceWriter,
  type SourceSQL,
} from "./substrate-source-state";

const READ_OPERATIONS = new Set(["stat", "list", "read", "search", "events"]);
const WRITE_OPERATIONS = new Set(["write", "mkdir", "rename", "delete"]);

export async function forwardSourceRequest(
  hub: RuntimeHub,
  hosts: SourceHostManager,
  workspaceID: string,
  attemptID: string | null,
  operation: string,
  request: Request,
  sql: SourceSQL,
) {
  const row = await readSourceLease(workspaceID, sql);
  const state = row ? classifySourceLease(row) : null;
  if (
    !state ||
    state.phase === "actor-freezing" ||
    state.phase === "actor-frozen" ||
    ((state.phase === "service-freezing" || state.phase === "service-frozen") &&
      !READ_OPERATIONS.has(operation)) ||
    (state.phase === "actor-live" && (!attemptID || !hub.sourceConnected(attemptID)))
  )
    throw new CommandError(
      "unavailable",
      "Current Source writer is frozen or unavailable; keep the editor buffer",
    );
  if (WRITE_OPERATIONS.has(operation)) {
    const role = await readSourceWriter(state, sql);
    if (!role.writable || request.headers.get("X-Factory-Writer-Epoch") !== String(role.epoch))
      throw new CommandError("conflict", "Source writer changed; keep the editor buffer");
    const fence = await hosts.request(
      workspaceID,
      attemptID,
      state,
      "fence",
      new Request("http://source.internal/", {
        method: "POST",
        body: JSON.stringify({ writerEpoch: role.epoch, writable: true }),
        signal: request.signal,
      }),
      sql,
    );
    if (!fence.ok || (await fence.json()).confirmed !== true)
      throw new CommandError("unavailable", "Source writing fence is unconfirmed");
  }
  return hosts.request(workspaceID, attemptID, state, operation, request, sql);
}

export async function fenceSourceWriter(
  hub: RuntimeHub,
  hosts: SourceHostManager,
  workspaceID: string,
  attemptID: string,
  epoch: string,
  writable: boolean,
  sql: SourceSQL,
  requireLiveRole = false,
) {
  const row = await readSourceLease(workspaceID, sql);
  // Initial bootstrap reads the saved Change role before exposing Source.
  if (!row) {
    if (requireLiveRole)
      throw new CommandError("unavailable", "Current Source role is unavailable");
    return;
  }
  const state = classifySourceLease(row);
  if (
    requireLiveRole &&
    (state.phase !== "actor-live" || !hub.ready(attemptID) || !hub.sourceConnected(attemptID))
  )
    throw new CommandError("unavailable", "Current Source role cannot be confirmed");
  if (!state.writable) {
    if (!writable && isFrozenLease(state)) return;
    throw new CommandError("unavailable", "Source owner is frozen; writing fence is unconfirmed");
  }
  const response = await hosts.request(
    workspaceID,
    attemptID,
    state,
    "fence",
    new Request("http://source.internal/", {
      method: "POST",
      body: JSON.stringify({ writerEpoch: Number(epoch), writable }),
      signal: AbortSignal.timeout(10_000),
    }),
    sql,
  );
  if (!response.ok || (await response.json()).confirmed !== true)
    throw new CommandError(
      "unavailable",
      "Source writing fence is unconfirmed. Existing buffers are preserved.",
    );
}
