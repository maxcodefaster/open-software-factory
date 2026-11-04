import type { ServerFunctionsSend } from "@solidjs/web/server-functions/client";

// Reads are named where they are declared (`registerSharedReads`). Identical
// reads that overlap in flight share one request; nothing is kept after the
// response arrives. Any other call, a write or an unregistered function,
// invalidates in-flight reads, and so does a Zero version change.
const readIDs = new Set<string>();

export function registerSharedReads(...reads: unknown[]) {
  for (const read of reads) {
    const id = (read as { serverFnMeta?: { id?: unknown } } | undefined)?.serverFnMeta?.id;
    if (typeof id === "string" && id) readIDs.add(id);
  }
}

export function addressFunctionID(address: string) {
  const path = address.split(/[?#]/, 1)[0] ?? "";
  const segment = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface SharedRead {
  response: Promise<Response>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export function createSharedReadTransport(options: {
  isRead(id: string): boolean;
  send?: ServerFunctionsSend;
}) {
  const inflight = new Map<string, SharedRead>();
  const send: ServerFunctionsSend = (address, init) =>
    options.send ? options.send(address, init) : fetch(address, init);

  function invalidate() {
    inflight.clear();
  }

  function share(address: string, init: RequestInit & { body: string }) {
    const key = `${address}\n${init.body}`;
    let shared = inflight.get(key);
    if (!shared) {
      const controller = new AbortController();
      const created: SharedRead = {
        controller,
        consumers: 0,
        settled: false,
        response: Promise.resolve(send(address, { ...init, signal: controller.signal })),
      };
      const done = () => {
        created.settled = true;
        if (inflight.get(key) === created) inflight.delete(key);
      };
      created.response.then(done, done);
      inflight.set(key, created);
      shared = created;
    }
    const entry = shared;
    entry.consumers++;
    const caller = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let finished = false;
      const onAbort = () => {
        if (finished) return;
        finished = true;
        entry.consumers--;
        if (entry.consumers === 0 && !entry.settled) {
          if (inflight.get(key) === entry) inflight.delete(key);
          entry.controller.abort();
        }
        reject(caller?.reason ?? new DOMException("This operation was aborted", "AbortError"));
      };
      if (caller?.aborted) return onAbort();
      caller?.addEventListener("abort", onAbort, { once: true });
      entry.response.then(
        // The original body stays unread so every consumer reads its own copy.
        (response) => {
          if (finished) return;
          finished = true;
          caller?.removeEventListener("abort", onAbort);
          resolve(response.clone());
        },
        (cause) => {
          if (finished) return;
          finished = true;
          caller?.removeEventListener("abort", onAbort);
          reject(cause);
        },
      );
    });
  }

  const transport: ServerFunctionsSend = (address, init) => {
    const id = addressFunctionID(address);
    if (!options.isRead(id)) {
      invalidate();
      const sent = Promise.resolve(send(address, init));
      sent.then(invalidate, invalidate);
      return sent;
    }
    if (typeof init.body !== "string" || (init.method ?? "POST").toUpperCase() !== "POST")
      return send(address, init);
    return share(address, { ...init, body: init.body });
  };

  return { fetch: transport, invalidate, pending: () => inflight.size };
}

const shared = createSharedReadTransport({ isRead: (id) => readIDs.has(id) });

export const sharedReadFetch = shared.fetch;

// A Zero version change means an older in-flight answer may predate the change.
// Observers reacting to one cause (the same event or version) invalidate once, so the
// reads they start afterwards still share.
let lastCause: unknown;
export function invalidateSharedReads(cause?: unknown) {
  if (cause !== undefined && cause === lastCause) return;
  lastCause = cause;
  shared.invalidate();
}
