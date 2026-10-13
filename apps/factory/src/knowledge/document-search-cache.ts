type Entry = { path: string; sha: string; title: string; body: string };
export function createDocumentSearchCache() {
  const entries = new Map<string, { promise: Promise<Entry[]>; bytes: number }>();
  let retainedBytes = 0;
  return {
    get(key: string, load: () => Promise<Entry[]>) {
      const cached = entries.get(key);
      if (cached) return cached.promise;
      const entry = { promise: Promise.resolve<Entry[]>([]), bytes: 0 };
      entry.promise = load()
        .then((documents) => {
          const bytes = documents.reduce(
            (total, document) => total + new TextEncoder().encode(document.body).byteLength,
            0,
          );
          if (bytes > 16 * 1024 * 1024)
            throw new Error("Repository documents exceed the full-text search size limit.");
          if (entries.get(key) === entry) {
            entry.bytes = bytes;
            retainedBytes += bytes;
            while (entries.size > 8 || retainedBytes > 32 * 1024 * 1024) {
              const oldest = entries.entries().next().value;
              if (!oldest) break;
              retainedBytes -= oldest[1].bytes;
              entries.delete(oldest[0]);
            }
          }
          return documents;
        })
        .catch((cause: unknown) => {
          if (entries.get(key) === entry) {
            retainedBytes -= entry.bytes;
            entries.delete(key);
          }
          throw cause;
        });
      entries.set(key, entry);
      while (entries.size > 8) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        retainedBytes -= oldest[1].bytes;
        entries.delete(oldest[0]);
      }
      return entry.promise;
    },
  };
}
