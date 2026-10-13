export type RepositoryFile = { path: string; sha: string; size: number };

/** Read-only source caches. Keys include repository identity; failed reads are never retained. */
export function createRepositoryKnowledgeCache() {
  const inventories = new Map<string, Promise<RepositoryFile[]>>();
  const contents = new Map<string, { value: Promise<string>; bytes: number }>();
  let contentBytes = 0;
  const maximumBytes = 16 * 1024 * 1024;

  return {
    inventory(repository: string, commit: string, load: () => Promise<RepositoryFile[]>) {
      const key = `${repository}:${commit}`;
      const cached = inventories.get(key);
      if (cached) return cached;
      const value = load().catch((cause: unknown) => {
        if (inventories.get(key) === value) inventories.delete(key);
        throw cause;
      });
      inventories.set(key, value);
      while (inventories.size > 32) {
        const oldest = inventories.keys().next().value;
        if (oldest !== undefined) inventories.delete(oldest);
      }
      return value;
    },
    content(repository: string, blob: string, load: () => Promise<string>) {
      const key = `${repository}:${blob}`;
      const cached = contents.get(key);
      if (cached) return cached.value;
      const entry = { value: Promise.resolve(""), bytes: 0 };
      function remove() {
        if (contents.get(key) !== entry) return;
        contentBytes -= entry.bytes;
        contents.delete(key);
      }
      entry.value = load()
        .then((text) => {
          const bytes = new TextEncoder().encode(text).byteLength;
          if (bytes > 250_000)
            throw new Error("Repository document exceeds the readable size limit");
          if (contents.get(key) === entry) {
            entry.bytes = bytes;
            contentBytes += bytes;
            while (contentBytes > maximumBytes || contents.size > 512) {
              const oldest = contents.entries().next().value;
              if (!oldest) break;
              contentBytes -= oldest[1].bytes;
              contents.delete(oldest[0]);
            }
          }
          return text;
        })
        .catch((cause: unknown) => {
          remove();
          throw cause;
        });
      contents.set(key, entry);
      return entry.value;
    },
  };
}
