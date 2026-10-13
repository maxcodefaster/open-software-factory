import { mkdir, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const image = z.string().regex(/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/);
const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,31}$/)
  .refine((value) => !["local", "default"].includes(value));
const port = z.number().int().min(1024).max(65535);
const installationSchema = z
  .object({
    version: z.literal(1),
    disposable: z.literal(true),
    name,
    owner: z.uuid(),
    phase: z.enum(["active", "reset-intent", "reset"]),
    ports: z.object({ factory: port, postgres: port, forgejo: port, zero: port }).strict(),
    runtimeImage: image,
    browserImage: image,
    resetRuntimeNamespaces: z
      .array(z.string().regex(/^factory-(workspace|runtime)-[a-f0-9]{12}$/))
      .optional(),
  })
  .strict()
  .refine((value) => new Set(Object.values(value.ports)).size === 4)
  .refine((value) => value.phase === "active" || value.resetRuntimeNamespaces !== undefined);

export type DisposableInstallation = z.infer<typeof installationSchema>;

export function installationName(value: string) {
  if (!name.safeParse(value).success)
    throw new Error(
      "Disposable installation name must be 3-32 lowercase letters, digits or hyphens; local/default are reserved",
    );
  return value;
}

export function parseInstallation(value: unknown, expectedName: string): DisposableInstallation {
  const parsed = installationSchema.safeParse(value);
  if (!parsed.success || parsed.data.name !== installationName(expectedName))
    throw new Error("Disposable installation identity is missing or invalid");
  return parsed.data;
}

export function installationDirectory(root: string, id: string) {
  return resolve(root, ".factory/installations", installationName(id));
}

export async function loadInstallation(root: string, id: string) {
  const directory = installationDirectory(root, id);
  const file = resolve(directory, "installation.json");
  if (
    (await realpath(directory)) !== installationDirectory(await realpath(root), id) ||
    !(await lstat(file)).isFile()
  )
    throw new Error("Disposable installation cannot use redirected state paths");
  return parseInstallation(JSON.parse(await readFile(file, "utf8")), id);
}

export async function createInstallation(
  root: string,
  id: string,
  pins: { runtimeImage: string; browserImage: string },
) {
  const directory = installationDirectory(root, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== installationDirectory(await realpath(root), id))
    throw new Error("Disposable installation cannot use redirected state paths");
  const existing = await lstat(resolve(directory, "installation.json")).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (existing) {
    const value = await loadInstallation(root, id);
    if (value.phase !== "active")
      throw new Error("Disposable installation was reset; use a new name");
    return value;
  }
  const reservations = Array.from({ length: 4 }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) }),
  );
  try {
    const [factory, postgres, forgejo, zero] = reservations.map((value) => value.port);
    const value = parseInstallation(
      {
        version: 1,
        disposable: true,
        name: id,
        owner: crypto.randomUUID(),
        phase: "active",
        ports: { factory, postgres, forgejo, zero },
        ...pins,
      },
      id,
    );
    // Persist identity and chosen ports before any external create. Never overwrite another owner.
    await writeFile(resolve(directory, "installation.json"), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return value;
  } finally {
    await Promise.all(reservations.map((value) => value.stop(true)));
  }
}

export function composeProject(value: DisposableInstallation) {
  return `factory-disposable-${value.name}`;
}

export function composeEnvironment(value: DisposableInstallation) {
  return {
    FACTORY_INSTALLATION_OWNER: value.owner,
    FACTORY_INSTALLATION_DISPOSABLE: "true",
    FACTORY_LOCAL_PORT: String(value.ports.factory),
    FACTORY_LOCAL_POSTGRES_PORT: String(value.ports.postgres),
    FACTORY_LOCAL_FORGEJO_PORT: String(value.ports.forgejo),
    FACTORY_LOCAL_ZERO_PORT: String(value.ports.zero),
  };
}

export function requireResetConfirmation(
  value: DisposableInstallation | null,
  confirm: string | undefined,
  data: boolean,
) {
  if (!value || !data || confirm !== value.name)
    throw new Error(
      "Reset requires --data --disposable <name> --confirm <same-name>; the developer installation cannot be reset",
    );
}

export function requireOwnedResource(
  value: DisposableInstallation,
  resource: { labels: Record<string, string> | null | undefined; projectLabel: string },
) {
  const labels = resource.labels;
  if (
    labels?.["factory.dev/installation"] !== value.owner ||
    labels["factory.dev/disposable"] !== "true" ||
    labels[resource.projectLabel] !== composeProject(value)
  )
    throw new Error("Reset refused a resource with unknown disposable ownership");
}
