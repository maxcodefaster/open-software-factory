import { z } from "zod";
import { removeStoppedEditorSourceNamespace } from "./editor-source-resources";

const target = z
  .object({
    namespace: z.string().regex(/^factory-(workspace|editor)-[a-f0-9]+$/),
    ownerID: z.uuid(),
    uid: z.string().min(1).optional(),
  })
  .strict()
  .parse(JSON.parse(process.argv[2] ?? "null"));
await removeStoppedEditorSourceNamespace(target.namespace, {
  ownerID: target.ownerID,
  ...(target.uid ? { uid: target.uid } : {}),
});
process.stdout.write(JSON.stringify({ removed: true }));
