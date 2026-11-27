import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { RuntimeChannelState } from "./hub-channels";
import {
  type ConnectorMessage,
  type ParentOperationResult,
  type PendingChildOperation,
  type PendingParentOperation,
  RuntimeParentOperationError,
  type RuntimeSocketData,
} from "./hub-types";

export class RuntimeOperationManager {
  readonly #channels: RuntimeChannelState;
  readonly #pendingOperations = new Map<string, PendingParentOperation>();
  readonly #pendingChildOperations = new Map<string, PendingChildOperation>();

  constructor(channels: RuntimeChannelState) {
    this.#channels = channels;
  }

  handleOperationResponse(
    socket: ServerWebSocket<RuntimeSocketData>,
    message: ConnectorMessage,
  ): boolean {
    if (socket.data.kind !== "connector") return false;
    if (
      socket.data.role === "child" &&
      message.type === "operation-response" &&
      message.operationId
    ) {
      const pending = this.#pendingChildOperations.get(message.operationId);
      if (!pending || pending.attemptID !== socket.data.attemptID || pending.connector !== socket)
        return true;
      clearTimeout(pending.timer);
      this.#pendingChildOperations.delete(message.operationId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.data);
      return true;
    }
    if (
      socket.data.role === "parent" &&
      message.type === "operation-response" &&
      message.operationId
    ) {
      const pending = this.#pendingOperations.get(message.operationId);
      if (
        !pending ||
        pending.attemptID !== socket.data.attemptID ||
        pending.connector !== socket ||
        this.#channels.parents.get(pending.attemptID) !== socket ||
        pending.action !== message.action
      )
        return true;
      clearTimeout(pending.timer);
      this.#pendingOperations.delete(message.operationId);
      if (message.error)
        pending.reject(new RuntimeParentOperationError(pending.action, message.error));
      else
        pending.resolve({
          ...(message.commitSha ? { commitSHA: message.commitSha } : {}),
          ...(message.remoteSha ? { remoteSHA: message.remoteSha } : {}),
          ...(message.data !== undefined ? { data: message.data } : {}),
        });
      return true;
    }
    return false;
  }

  async parentOperation(
    attemptID: string,
    operation: Record<string, string | number> & { operationId: string; action: string },
    beforeSend?: (send: () => void) => Promise<void>,
  ): Promise<ParentOperationResult> {
    const checkpointDrain = () =>
      operation.action === "source-drain" && this.#channels.sourceConnected(attemptID);
    if (this.#channels.idleClaims.has(attemptID) && !checkpointDrain())
      throw new Error("Runtime is stopping");
    const parent = this.#channels.parents.get(attemptID);
    if (!parent) throw new Error("Runtime parent is not ready");
    const permitted = () => this.#channels.isParentOperationPermitted(parent, operation.action);
    if (!permitted())
      throw new Error("Failed Parent permits only retained Source checkpoint operations");
    const operationID = operation["operationId"];
    if (!operationID) throw new Error("Operation identity is required");
    const payload = { ...operation };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
        ),
      )
      .digest("hex");
    const existing = this.#pendingOperations.get(operationID);
    if (existing) {
      if (existing.attemptID !== attemptID || existing.fingerprint !== fingerprint)
        throw new Error("Runtime parent operation identity has conflicting input");
      return existing.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<ParentOperationResult>();
    const timer = setTimeout(
      () => {
        if (this.#pendingOperations.get(operationID) !== target) return;
        this.#pendingOperations.delete(operationID);
        reject(new Error("Runtime parent operation timed out"));
      },
      operation.action === "browser-renew" ? 5_000 : 60_000,
    );
    const target: PendingParentOperation = {
      attemptID,
      connector: parent,
      action: payload["action"] ?? "",
      fingerprint,
      promise,
      resolve,
      reject,
      timer,
    };
    this.#pendingOperations.set(operationID, target);
    const send = () => {
      if (this.#channels.idleClaims.has(attemptID) && !checkpointDrain())
        throw new Error("Runtime is stopping");
      if (this.#pendingOperations.get(operationID) !== target)
        throw new Error("Runtime parent operation is no longer pending");
      if (this.#channels.parents.get(attemptID) !== parent)
        throw new Error("Runtime parent connection changed before dispatch");
      if (!permitted())
        throw new Error("Failed Parent permits only retained Source checkpoint operations");
      if (parent.send(JSON.stringify({ ...payload, type: "operation-request" })) === 0)
        throw new Error("Runtime parent operation could not be sent");
      this.#channels.touch(attemptID);
    };
    const forward = async () => {
      if (beforeSend) await beforeSend(send);
      else send();
    };
    void forward().catch((cause: unknown) => {
      if (this.#pendingOperations.get(operationID) !== target) return;
      clearTimeout(target.timer);
      this.#pendingOperations.delete(operationID);
      target.reject(cause instanceof Error ? cause : new Error("Runtime parent send failed"));
    });
    return promise;
  }

  async childOperation(attemptID: string, operation: Record<string, string>): Promise<void> {
    const operationID = operation["operationId"];
    if (operationID && this.#pendingChildOperations.has(operationID))
      throw new Error("Runtime child operation is already pending");
    await this.childRequest(attemptID, operation);
  }

  async childRequest(
    attemptID: string,
    operation: Record<string, string>,
    beforeSend?: (send: () => void) => Promise<void>,
  ): Promise<string | undefined> {
    const payload = { ...operation };
    const checkpointDrain = () =>
      payload["action"] === "source-drain" && this.#channels.sourceConnected(attemptID);
    if (this.#channels.idleClaims.has(attemptID) && !checkpointDrain())
      throw new Error("Runtime is stopping");
    const child = this.#channels.children.get(attemptID);
    if (!child) throw new Error("Runtime child is not ready");
    const operationID = payload["operationId"];
    if (!operationID) throw new Error("Operation identity is required");
    const fingerprint = JSON.stringify(
      Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
    );
    const previous = this.#pendingChildOperations.get(operationID);
    if (previous) {
      if (previous.attemptID !== attemptID || previous.fingerprint !== fingerprint)
        throw new Error("Runtime child operation identity already has different input");
      return previous.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    const timer = setTimeout(() => {
      if (this.#pendingChildOperations.get(operationID) !== target) return;
      this.#pendingChildOperations.delete(operationID);
      reject(new Error("Runtime child operation timed out"));
    }, 20_000);
    const target: PendingChildOperation = {
      attemptID,
      connector: child,
      action: payload["action"] ?? "",
      fingerprint,
      promise,
      resolve,
      reject,
      timer,
    };
    this.#pendingChildOperations.set(operationID, target);
    const send = () => {
      if (this.#pendingChildOperations.get(operationID) !== target)
        throw new Error("Runtime child operation is no longer pending");
      if (
        (this.#channels.idleClaims.has(attemptID) && !checkpointDrain()) ||
        this.#channels.children.get(attemptID) !== child
      )
        throw new Error("Runtime child changed before dispatch");
      // Bun returns -1 when the frame was accepted into its backpressure queue.
      // Only zero means the connection dropped the frame.
      if (child.send(JSON.stringify({ ...payload, type: "operation-request" })) === 0)
        throw new Error("Runtime child operation could not be sent");
      this.#channels.touch(attemptID);
    };
    const forward = async () => {
      if (beforeSend) await beforeSend(send);
      else send();
    };
    void forward().catch((cause: unknown) => {
      const pending = this.#pendingChildOperations.get(operationID);
      if (pending !== target) return;
      clearTimeout(pending.timer);
      this.#pendingChildOperations.delete(operationID);
      pending.reject(cause instanceof Error ? cause : new Error("Runtime child send failed"));
    });
    return promise;
  }

  hasPendingForAttempt(attemptID: string) {
    for (const operation of this.#pendingOperations.values())
      if (operation.attemptID === attemptID) return true;
    for (const operation of this.#pendingChildOperations.values())
      if (operation.attemptID === attemptID) return true;
    return false;
  }

  failAttemptOperations(
    attemptID: string,
    message: string,
    connector?: ServerWebSocket<RuntimeSocketData>,
  ) {
    for (const [operationID, pending] of this.#pendingOperations) {
      if (pending.attemptID !== attemptID || (connector && pending.connector !== connector))
        continue;
      clearTimeout(pending.timer);
      this.#pendingOperations.delete(operationID);
      pending.reject(new Error(message));
    }
    for (const [operationID, pending] of this.#pendingChildOperations) {
      if (pending.attemptID !== attemptID || (connector && pending.connector !== connector))
        continue;
      clearTimeout(pending.timer);
      this.#pendingChildOperations.delete(operationID);
      pending.reject(new Error(message));
    }
  }
}
