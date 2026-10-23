import { expect, test } from "bun:test";
import { createAttachmentObjects } from "../../apps/factory/src/attachments/objects";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";

test("the pinned native S3 service retains private bytes, reconciles exact writes and deletes only the owned key", async () => {
  const owned = await ownedAttachmentS3();
  const objects = createAttachmentObjects();
  const key = `native-proof/${crypto.randomUUID()}`;
  const other = `native-proof/${crypto.randomUUID()}`;
  const data = new TextEncoder().encode("Retained immutable attachment 7319");
  try {
    await objects.put(key, data, "text/plain");
    await objects.put(key, data, "text/plain");
    expect(new TextDecoder().decode(await objects.read(key))).toContain("7319");
    expect((await fetch(`${owned.endpoint}/factory-attachments/${key}`)).status).toBe(403);
    await expect(objects.put(key, new Uint8Array([0]), "text/plain")).rejects.toThrow("immutable");
    await objects.put(other, new TextEncoder().encode("Unrelated owned control"), "text/plain");
    await objects.remove(key);
    await objects.remove(key);
    expect(new TextDecoder().decode(await objects.read(other))).toBe("Unrelated owned control");
    await objects.remove(other);
  } finally {
    await owned.dispose();
  }
});
