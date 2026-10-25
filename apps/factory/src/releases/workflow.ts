import { parse } from "yaml";
import { z } from "zod";

export const publicationWorkflow = ".forgejo/workflows/factory-release.yml";
export const publicationLabel = "factory-publication";
export function validatePublicationWorkflow(source: string) {
  if (source.length > 65_536) throw new Error("Release workflow is too large");
  const value = z
    .object({
      on: z.record(z.string(), z.unknown()),
      jobs: z.record(
        z.string(),
        z
          .object({
            "runs-on": z.unknown(),
            strategy: z.unknown().optional(),
            needs: z.unknown().optional(),
            uses: z.unknown().optional(),
          })
          .loose(),
      ),
    })
    .loose()
    .parse(parse(source));
  const triggers = value.on;
  if (!triggers || Object.keys(triggers).join() !== "workflow_dispatch")
    throw new Error("Release workflow must run only on workflow_dispatch");
  const dispatch = z
    .object({
      inputs: z.record(z.string(), z.object({ required: z.boolean() }).loose()),
    })
    .parse(triggers["workflow_dispatch"]);
  const inputs = dispatch.inputs;
  if (
    Object.keys(inputs).sort().join() !==
    ["factory_release_id", "version", "package_owner"].sort().join()
  )
    throw new Error("Release workflow may declare only the three frozen publication inputs");
  for (const name of ["factory_release_id", "version", "package_owner"])
    if (inputs?.[name]?.required !== true)
      throw new Error(`Release workflow must declare required ${name} input`);
  if (Object.keys(value.jobs).join() !== "publish")
    throw new Error("Release workflow must contain one publish job");
  const job = value.jobs["publish"];
  if (!job) throw new Error("Publication job is missing");
  if (job.strategy || job.needs || job.uses)
    throw new Error("Release matrix, dependent jobs and reusable jobs are not supported");
  if (
    JSON.stringify(job["runs-on"]) !==
    JSON.stringify([publicationLabel, `factory-release-\${{ inputs.factory_release_id }}`])
  )
    throw new Error("Release workflow must use the isolated Factory publication labels");
}
