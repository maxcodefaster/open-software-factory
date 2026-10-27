import { objectDigest, type PrivateObjects } from "../../apps/factory/src/storage/objects";

export function memoryPrivateObjects(): PrivateObjects & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(key, data) {
      const previous = blobs.get(key);
      if (previous && objectDigest(previous) !== objectDigest(data))
        throw new Error("Stored object does not match its immutable content");
      blobs.set(key, data.slice());
    },
    async read(key) {
      const data = blobs.get(key);
      if (!data) throw new Error("Owned object absent");
      return data.slice();
    },
    async remove(key) {
      blobs.delete(key);
    },
    async open(key, range) {
      const data = blobs.get(key);
      if (!data) return new Response(null, { status: 404 });
      if (range)
        return new Response(data.slice(range.start, range.end + 1), {
          status: 206,
          headers: {
            "content-length": String(range.end - range.start + 1),
            "content-range": `bytes ${range.start}-${range.end}/${data.length}`,
          },
        });
      return new Response(data.slice(), { headers: { "content-length": String(data.length) } });
    },
  };
}
