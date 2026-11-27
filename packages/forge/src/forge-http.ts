import { z } from "zod";
import type { ForgeRepository } from "./contracts";

export const VERIFICATION_WORKFLOW_PATH = ".forgejo/workflows/factory-verification.yml";

export class ForgeConflictError extends Error {
  override readonly name = "ForgeConflictError";
}

export class ForgeAmbiguousWriteError extends Error {
  override readonly name = "ForgeAmbiguousWriteError";
}

export class ForgeHttpError extends Error {
  constructor(readonly status: number) {
    super(`Forge request failed with HTTP ${status}`);
  }
}

export class ForgeTransportError extends Error {}

export const sha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

export function segment(value: string) {
  if (!value || value === "." || value === ".." || value.includes("\\")) {
    throw new TypeError("Forge path segment is invalid");
  }
  return encodeURIComponent(value);
}

export function repositoryPath(repository: ForgeRepository) {
  return `repos/${segment(repository.owner)}/${segment(repository.name)}`;
}

export function encodeRepoFilePath(path: string) {
  return path.split("/").filter(Boolean).map(segment).join("/");
}

export function hasInvalidRelativePath(path: string) {
  return (
    path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\")
  );
}

export function isNotFound(error: unknown) {
  return error instanceof ForgeHttpError && error.status === 404;
}

export function isConflictOrUnprocessable(error: unknown) {
  return error instanceof ForgeHttpError && (error.status === 409 || error.status === 422);
}

export function isAmbiguousError(error: unknown) {
  return (
    error instanceof ForgeTransportError ||
    error instanceof DOMException ||
    (error instanceof ForgeHttpError && (error.status === 408 || error.status === 429)) ||
    (error instanceof ForgeHttpError && error.status >= 500)
  );
}

export async function readAfterWrite<T>(
  error: unknown,
  read: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (isAmbiguousError(error)) throw new ForgeAmbiguousWriteError(message, { cause });
    throw cause;
  }
}

export async function recoverIdempotentCreate<T>(
  error: unknown,
  options: {
    read: () => Promise<T | null>;
    matches: (value: T) => boolean;
    unknownMessage: string;
    conflictMessage: (value: T) => string;
  },
): Promise<T> {
  if (!isConflictOrUnprocessable(error) && !isAmbiguousError(error)) {
    throw error;
  }
  const recovered = await readAfterWrite(error, options.read, options.unknownMessage);
  if (recovered) {
    if (options.matches(recovered)) return recovered;
    throw new ForgeConflictError(options.conflictMessage(recovered));
  }
  if (isAmbiguousError(error)) {
    throw new ForgeAmbiguousWriteError(options.unknownMessage);
  }
  throw error;
}

export interface ForgeClientOptions {
  readonly apiURL: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export interface ForgeTransport {
  send(path: string, init?: RequestInit): Promise<Response>;
  response(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<unknown>;
  jsonBody(path: string, method: string, payload: unknown, init?: RequestInit): Promise<unknown>;
  deleteOptional(path: string): Promise<void>;
}

export function createForgeTransport(options: ForgeClientOptions): ForgeTransport {
  const request = options.fetch ?? fetch;
  const baseURL = new URL(options.apiURL.endsWith("/") ? options.apiURL : `${options.apiURL}/`);

  async function send(path: string, init: RequestInit = {}) {
    const url = new URL(path, baseURL);
    const requestInit: RequestInit = {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    };
    try {
      return await request(url, requestInit);
    } catch (cause) {
      if (cause instanceof TypeError)
        throw new ForgeTransportError("Forge request reply is unavailable", { cause });
      throw cause;
    }
  }

  async function response(path: string, init: RequestInit = {}) {
    const result = await send(path, init);
    if (!result.ok) throw new ForgeHttpError(result.status);
    return result;
  }

  async function json(path: string, init: RequestInit = {}) {
    return (await response(path, init)).json() as Promise<unknown>;
  }

  async function jsonBody(path: string, method: string, payload: unknown, init: RequestInit = {}) {
    return json(path, { ...init, method, body: JSON.stringify(payload) });
  }

  async function deleteOptional(path: string) {
    try {
      await response(path, { method: "DELETE" });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  return { send, response, json, jsonBody, deleteOptional };
}
