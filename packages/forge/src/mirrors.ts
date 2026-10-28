import { z } from "zod";
import type { RepositoryMirror } from "../../project-domain/src/repository-mirror";
import type { ForgeRepository } from "./forge";

const mirror = z.object({
  remote_name: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  remote_address: z.string().max(4096),
  sync_on_commit: z.boolean(),
  interval: z.string(),
  branch_filter: z.string().default(""),
  last_update: z.string(),
  last_error: z.string(),
});

export class ForgeMirrorWriteError extends Error {
  constructor(readonly unconfirmed: boolean) {
    super(
      unconfirmed
        ? "Mirror operation is unconfirmed. Refresh its native status before another operation."
        : "Forgejo refused the mirror operation. Check the target and its access.",
    );
  }
}

function metadata(value: z.output<typeof mirror>): RepositoryMirror {
  // Forgejo stores the native remote's credentials. Never forward userinfo,
  // URL parameters or native Git errors to a browser.
  const url = new URL(value.remote_address);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const timestamp = Date.parse(value.last_update);
  return {
    remoteName: value.remote_name,
    targetURL: url.toString(),
    syncOnCommit: value.sync_on_commit,
    interval: value.interval,
    branchFilter: value.branch_filter,
    lastAttempt:
      Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null,
    failed: value.last_error.length > 0,
  };
}

async function body(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Mirror metadata is unavailable");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 262_144) throw new Error("Mirror metadata exceeds its bound");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createForgejoPushMirrors(
  send: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const path = (repo: ForgeRepository) =>
    `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/push_mirrors`;
  async function write(route: string, init: RequestInit, missingOK = false) {
    let response: Response;
    try {
      response = await send(route, {
        ...init,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new ForgeMirrorWriteError(true);
    }
    if (!response.ok && !(missingOK && response.status === 404)) {
      await response.body?.cancel();
      throw new ForgeMirrorWriteError(
        response.status >= 500 || [408, 429].includes(response.status),
      );
    }
    return response;
  }
  return {
    async list(repo: ForgeRepository): Promise<RepositoryMirror[]> {
      const result: RepositoryMirror[] = [];
      for (let page = 1; page <= 100; page++) {
        const response = await send(`${path(repo)}?limit=50&page=${page}`);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Forgejo mirror status is unavailable");
        }
        const entries = z.array(mirror).parse(await body(response));
        result.push(...entries.map(metadata));
        if (entries.length < 50) return result;
      }
      throw new Error("Forgejo mirror listing is incomplete");
    },
    async create(
      repo: ForgeRepository,
      input: { targetURL: string; username: string; token: string },
    ) {
      const response = await write(path(repo), {
        method: "POST",
        body: JSON.stringify({
          remote_address: input.targetURL,
          remote_username: input.username,
          remote_password: input.token,
          interval: "1h",
          sync_on_commit: true,
          branch_filter: "",
          use_ssh: false,
        }),
      });
      try {
        return metadata(mirror.parse(await body(response)));
      } catch {
        throw new ForgeMirrorWriteError(true);
      }
    },
    async remove(repo: ForgeRepository, name: string) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(name)) throw new Error("Invalid mirror identity");
      const response = await write(
        `${path(repo)}/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
        },
        true,
      );
      await response.body?.cancel();
    },
    async sync(repo: ForgeRepository) {
      // The pinned API synchronizes every native push mirror of this repository.
      // It is synchronous; an HTTP acknowledgement is not merely queue admission.
      const response = await write(`${path(repo)}-sync`, { method: "POST" });
      await response.body?.cancel();
    },
  };
}
