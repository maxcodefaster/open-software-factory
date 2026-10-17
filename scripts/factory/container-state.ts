import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const identity = z
  .object({ version: z.literal(1), project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/) })
  .strict();

// Called under the container's kernel lock, before secrets or external creates.
export async function requireContainerState(directory: string, project: string | undefined) {
  if (!project || project === "local")
    throw new Error("Set COMPOSE_PROJECT_NAME to a separate installation name, not local");
  const file = resolve(directory, "container-installation.json");
  const retained = await readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  const expected = identity.parse({ version: 1, project });
  if (retained !== null) {
    if (identity.parse(JSON.parse(retained)).project !== project)
      throw new Error("Factory state belongs to another Compose installation");
    return;
  }
  if (await Bun.file(resolve(directory, "server.json")).exists())
    throw new Error(
      "Use a separate FACTORY_STATE_DIRECTORY; this directory contains native development state",
    );
  await writeFile(file, JSON.stringify(expected), { mode: 0o600, flag: "wx" });
}
