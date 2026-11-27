import type { ServerWebSocket } from "bun";
import type { RuntimeProcessSnapshot } from "./process-contract";

export const HUB_PROTOCOL = "factory-runtime-connector-v1";
// Match the Connector's response-only cookie bounds; values stay ephemeral.
export const MAX_RESPONSE_COOKIES = 128;
export const MAX_RESPONSE_COOKIE_BYTES = 64 << 10;
export const MAX_BROWSER_APP_HEADERS = 128;
export const MAX_BROWSER_APP_HEADER_BYTES = 64 << 10;
export const MAX_APP_AUTHORIZATION_BYTES = 16 << 10;
export const MAX_BROWSER_SOCKET_FRAME_BYTES = 64 << 10;
export const MAX_BROWSER_SOCKET_QUEUE_BYTES = 1 << 20;

export type RuntimeSocketData =
  | {
      readonly kind: "connector";
      readonly role: "parent" | "child";
      readonly attemptID: string;
      readonly generation: number;
    }
  | {
      readonly kind: "browser";
      readonly attemptID: string;
      readonly channel: string;
      readonly path: string;
      readonly theiaConnectionToken?: string;
      readonly accessToken?: string;
      readonly headers?: Record<string, string>;
      readonly protocol?: string;
    };

export type ConnectorMessage = {
  type: string;
  role?: string;
  phase?: string;
  process?: string;
  processLabel?: string;
  processState?: string;
  startedAt?: string;
  exitCode?: number;
  terminalId?: string;
  terminalCount?: number;
  terminalBusy?: number;
  terminalRevision?: number;
  commandCount?: number;
  channels?: Array<{ name?: string; kind?: string; target?: string }>;
  sourceEpoch?: number;
  error?: string;
  streamId?: string;
  status?: number;
  headers?: Record<string, string>;
  cookies?: string[];
  data?: string;
  messageType?: number;
  protocol?: string;
  theiaConnectionToken?: string;
  operationId?: string;
  action?: string;
  commitSha?: string;
  remoteSha?: string;
};

export type ParentOperationResult = { commitSHA?: string; remoteSHA?: string; data?: string };

export class RuntimeParentOperationError extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeParentOperationError";
  }
}

export type PendingHTTP = {
  attemptID: string;
  connector: ServerWebSocket<RuntimeSocketData>;
  accessToken?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  body: ReadableStream<Uint8Array>;
  responded: boolean;
  head: boolean;
  keepsAwake: boolean;
  appPath?: string;
  originScopedCookies?: boolean;
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: Timer;
  detach(): void;
};

export type BrowserStream = {
  socket: ServerWebSocket<RuntimeSocketData>;
  connector: ServerWebSocket<RuntimeSocketData>;
  ready: boolean;
  pending: Array<{ messageType: 1 | 2; data: string }>;
};

export type BrowserAppIdentity = { actorUID: string; generation: number; target: string };
export type BrowserAppFrame = { messageType: 1 | 2; data: Uint8Array };
export type BrowserAppStream = {
  attemptID: string;
  connector: ServerWebSocket<RuntimeSocketData>;
  ready: boolean;
  protocol: string;
  bytes: number;
  controller: ReadableStreamDefaultController<BrowserAppFrame>;
  resolve(protocol: string): void;
  reject(error: Error): void;
  timer: Timer;
  detach(): void;
  assertCurrent(): void;
};

export type PendingParentOperation = {
  attemptID: string;
  connector: ServerWebSocket<RuntimeSocketData>;
  action: string;
  fingerprint: string;
  promise: Promise<ParentOperationResult>;
  resolve(value: ParentOperationResult): void;
  reject(error: Error): void;
  timer: Timer;
};

export type PendingChildOperation = {
  attemptID: string;
  connector: ServerWebSocket<RuntimeSocketData>;
  action: string;
  fingerprint: string;
  promise: Promise<string | undefined>;
  resolve(data?: string): void;
  reject(error: Error): void;
  timer: Timer;
};

export type ConnectorAuthority = {
  parentHash: string;
  childHash: string;
  generation: number;
  actorUID?: string;
};

export type StatusObservation = {
  authority: ConnectorAuthority | undefined;
  terminal: boolean;
  timer?: Timer;
};

export type AttemptActivity = {
  lastUse: number;
  terminals: number | null;
  busyTerminals: number | null;
  terminalObservedAt: number;
  revision: number;
};

export type ProcessMap = Map<string, RuntimeProcessSnapshot>;

export function createControlledStream<T>(
  cancel: () => void,
  strategy: QueuingStrategy<T>,
): { stream: ReadableStream<T>; controller: ReadableStreamDefaultController<T> } {
  let controller: ReadableStreamDefaultController<T> | undefined;
  const stream = new ReadableStream<T>(
    {
      start(value) {
        controller = value;
      },
      cancel,
    },
    strategy,
  );
  if (!controller) throw new Error("ReadableStream controller was not initialized");
  return { stream, controller };
}
