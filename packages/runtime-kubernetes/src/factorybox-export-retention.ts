import { readFileSync } from "node:fs";
import { z } from "zod";
import type { runCommand } from "./command";
import { factoryboxAdmissionID } from "./factorybox-location";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeImage,
  factoryboxRuntimeRequest,
} from "./factorybox-runtime";
import { type FactoryboxWorkerIdentity, inspectFactoryboxWorker } from "./factorybox-worker";

export const factoryboxExportRetirementProgram = readFileSync(
  new URL("./factorybox/retire-export.py", import.meta.url),
  "utf8",
);
const token = z.string().regex(/^[a-f0-9]{32}$/);
export const retiredFactoryboxExportOwner = z.strictObject({
  admissionID: token,
  podUID: z.string().min(1).max(128),
  epoch: token.nullable(),
  image: factoryboxRuntimeImage,
  seedNamespace: token.nullable(),
  terminal: z.strictObject({
    podUID: z.string().min(1).max(128),
    phase: z.enum(["Succeeded", "Failed"]),
  }),
});
export type RetiredFactoryboxExportOwner = z.infer<typeof retiredFactoryboxExportOwner>;

export function factoryboxExportRetirementRequest(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  previous: RetiredFactoryboxExportOwner,
) {
  const owner = retiredFactoryboxExportOwner.parse(previous);
  const admissionID = factoryboxAdmissionID(input.workerID, input.podName).replaceAll("-", "");
  if (
    !input.profile.retainedStore ||
    input.profile.retainedStore.storeID !== identity.storeID ||
    owner.admissionID === admissionID ||
    owner.podUID === identity.podUID ||
    owner.epoch === identity.epoch ||
    owner.terminal.podUID !== owner.podUID ||
    (owner.seedNamespace !== null && owner.seedNamespace !== owner.admissionID)
  )
    throw new Error("Export retirement requires a distinct positively terminated admission");
  return {
    version: 1 as const,
    storeID: identity.storeID,
    epoch: identity.epoch,
    podUID: identity.podUID,
    admissionID,
    previous: owner,
  };
}

export async function retireFactoryboxExports(
  input: FactoryboxRuntimeInput,
  identity: FactoryboxWorkerIdentity,
  previous: readonly RetiredFactoryboxExportOwner[],
  run: typeof runCommand,
) {
  if (!input.profile.retainedStore || !previous.length) return;
  for (const owner of previous) {
    const request = factoryboxExportRetirementRequest(input, identity, owner);
    await inspectFactoryboxWorker(
      factoryboxRuntimeRequest(input),
      identity,
      run,
      factoryboxRuntimeDeclaration(input),
    );
    const result = await run(
      [
        "exec",
        "-i",
        input.podName,
        "-n",
        input.namespace,
        "-c",
        "worker",
        "--",
        "python3",
        "-c",
        factoryboxExportRetirementProgram,
      ],
      JSON.stringify(request),
    );
    if (result.exitCode !== 0)
      throw new Error("Retired export cache needs observation; original receipts remain retained");
    const observed = z
      .object({
        version: z.literal(1),
        retired: z.array(
          z.object({
            image: factoryboxRuntimeImage,
            bytes: z.number().int().nonnegative().safe(),
            alreadyCompleted: z.boolean(),
          }),
        ),
        refused: z.array(z.string()),
        missing: z.array(z.string()),
      })
      .parse(JSON.parse(result.stdout));
    if (observed.refused.length)
      console.error("Retired export cache preserved unconfirmed payloads", owner.admissionID);
  }
}
