// Explicit offline data-service acceptance. This never starts Factory, Zero or a Forgejo server.
import { join, resolve } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import upstream from "../../upstream.json";
import type {
  Execute,
  FileWitness,
  Fixture,
  LoadedFixture,
  Receipt,
  Witnesses,
} from "./restore-rehearsal-types";
import { matchesRestoreSourceContract } from "./restore-source-contract";

export type { Execute, FileWitness, Fixture, LoadedFixture, Receipt, Witnesses };

export const images: Record<string, string> = {
  postgres: imagePins.postgres,
  forgejo: imagePins.forgejo,
  garage: imagePins.garage,
  openbao: imagePins.openbao,
  rclone: imagePins.rclone,
  tools: upstream.node.image,
};

// Resolve sibling modules from this directory, falling back to the repository's scripts/kubernetes
// directory when isolated source-contract tests copy only this file and restore-source-contract.ts.
async function loadSibling<T>(name: string): Promise<T> {
  try {
    return (await import(join(import.meta.dir, name))) as T;
  } catch {
    return (await import(resolve(process.cwd(), "scripts/kubernetes", name))) as T;
  }
}

const [
  commonMod,
  fixtureMod,
  dockerMod,
  witnessMod,
  archiveMod,
  forgejoMod,
  openbaoMod,
  componentsMod,
] = await Promise.all([
  loadSibling<typeof import("./restore-rehearsal-common")>("restore-rehearsal-common.ts"),
  loadSibling<typeof import("./restore-rehearsal-fixture")>("restore-rehearsal-fixture.ts"),
  loadSibling<typeof import("./restore-rehearsal-docker")>("restore-rehearsal-docker.ts"),
  loadSibling<typeof import("./restore-rehearsal-witness")>("restore-rehearsal-witness.ts"),
  loadSibling<typeof import("./restore-rehearsal-archive")>("restore-rehearsal-archive.ts"),
  loadSibling<typeof import("./restore-rehearsal-forgejo")>("restore-rehearsal-forgejo.ts"),
  loadSibling<typeof import("./restore-rehearsal-openbao")>("restore-rehearsal-openbao.ts"),
  loadSibling<typeof import("./restore-rehearsal-components")>("restore-rehearsal-components.ts"),
]);

export const { supportedSourceManifests, requiredTables, memberPath, resourcePlan, invocation } =
  commonMod;
export const { cleanupOwned } = dockerMod;
export const { rehearse } = componentsMod;
export const { forgejoWitnessProgram, postgresWitnessProgram } = witnessMod;
export const { restoreFiles } = archiveMod;
export const { validateForgejoDatabase } = forgejoMod;
export const { openBaoRequest } = openbaoMod;

/** Reads private inputs and, for content profiles, local Git objects. No daemon or writes. */
export function loadFixture(
  path: string,
  owner: string,
  mode?: "run" | "inspect",
): Promise<LoadedFixture>;
export function loadFixture(path: string, owner: string, mode: "cleanup"): Promise<Fixture>;
export function loadFixture(
  path: string,
  owner: string,
  mode: "run" | "inspect" | "cleanup" = "run",
): Promise<LoadedFixture | Fixture> {
  return fixtureMod.loadFixtureFromRepo(
    path,
    owner,
    mode,
    resolve(import.meta.dir, "../.."),
    matchesRestoreSourceContract,
  );
}

const cliModes: Record<string, "run" | "cleanup" | "plan" | "inspect"> = {
  "--run": "run",
  "--cleanup": "cleanup",
  "--plan": "plan",
  "--inspect": "inspect",
};

async function main(args: string[]) {
  const mode = cliModes[args[0] ?? ""];
  if (args.length !== 5 || mode === undefined || args[1] !== "--fixture" || args[3] !== "--owner")
    throw Error(
      "Usage: restore-rehearsal.ts --plan|--inspect|--run|--cleanup --fixture /private/fixture.json --owner <32 hex>",
    );
  const fixturePath = args[2] ?? "";
  const owner = args[4] ?? "";
  if (mode === "plan" || mode === "inspect") {
    const f = await loadFixture(fixturePath, owner, mode === "inspect" ? "inspect" : "run");
    console.log(
      JSON.stringify(
        {
          kind:
            mode === "inspect"
              ? "isolated-data-service-restore-inspection"
              : "isolated-data-service-restore-plan",
          owner: f.owner,
          source: f.source,
          set: f.set,
          images,
          resources: resourcePlan(f).map(({ kind, name }) => ({ kind, name })),
          limits: f.limits,
          witnessDigest: f.witnessDigest,
          nativeActivation: "not-run-not-qualified",
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const controller = new AbortController();
  let interrupted = 0;
  const interrupt = () => {
    interrupted ||= 130;
    controller.abort();
  };
  const terminate = () => {
    interrupted ||= 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (mode === "cleanup") {
      const f = await loadFixture(fixturePath, owner, "cleanup");
      return interrupted || ((await dockerMod.runCleanupCommand(f)) ? 0 : 1);
    }
    const f = await loadFixture(fixturePath, owner);
    const result = await componentsMod.rehearse(f, commonMod.safeExecute, controller.signal);
    console.log(
      `Isolated restore: ${result.status}; cleanup ${result.cleanup}; native activation not qualified`,
    );
    return interrupted || (result.status === "data-services-passed" ? 0 : 1);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error(
      "Restore rehearsal refused or incomplete; private input/command diagnostics suppressed",
    );
    process.exitCode = 1;
  }
}
