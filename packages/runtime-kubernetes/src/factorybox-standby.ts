import { z } from "zod";
import type { FactoryboxOperation } from "./factorybox-worker";

const state = z.object({
  record: z
    .object({
      id: z.string(),
      runtime_id: z.string().regex(/^fbx-[a-f0-9]{32}$/),
      phase: z.enum(["running", "paused"]),
      pause: z
        .object({
          snapshot_id: z.string(),
          completed_at: z.string().optional(),
          after: z.object({ anon: z.number() }).optional(),
          snapshot: z.object({ resident_bytes_after: z.number() }).optional(),
          resume: z.object({ completed_at: z.string().optional() }).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  runtime: z.object({ status: z.string() }).optional(),
});

interface StandbyCommands {
  state(): Promise<unknown>;
  intend(action: "pause" | "resume"): Promise<boolean>;
  execute(operation: FactoryboxOperation): Promise<unknown>;
}

export function readFactoryboxStandbyState(sandboxID: string, value: unknown) {
  const observed = state.parse(value);
  if (observed.record.id !== sandboxID)
    throw new Error("Standby observation belongs to another Sandbox");
  return observed;
}

// The slot owns one immutable standby snapshot. Observe an uncertain command;
// never repeat it or silently replace the prepared process with a cold start.
export async function settleFactoryboxStandby(
  sandboxID: string,
  snapshotID: string,
  action: "pause" | "resume",
  commands: StandbyCommands,
) {
  const read = (value: unknown) => readFactoryboxStandbyState(sandboxID, value);
  const completed = (observed: z.infer<typeof state>) => {
    const pause = observed.record.pause;
    if (pause?.snapshot_id !== snapshotID || !pause.completed_at)
      throw new Error("Standby snapshot is not confirmed by its original native record");
    if (action === "pause") {
      if (pause.after?.anon !== 0 || pause.snapshot?.resident_bytes_after !== 0)
        throw new Error("Standby Pause did not confirm released Sandbox memory");
    } else if (!pause.resume?.completed_at || observed.runtime?.status !== "running") {
      throw new Error("Standby Resume is not confirmed by its original native record");
    }
    return observed;
  };
  const expected = action === "pause" ? "paused" : "running";
  const before = read(await commands.state());
  if (before.record.phase === expected) return completed(before);
  if (action === "resume") {
    const pause = before.record.pause;
    if (pause?.snapshot_id !== snapshotID || !pause.completed_at)
      throw new Error("Standby Resume requires its exact completed Pause");
  }
  if (!(await commands.intend(action)))
    throw new Error(`Standby ${action} outcome is unconfirmed; observe without replay`);
  const after = read(await commands.execute({ action, sandboxID, snapshotID }));
  if (after.record.phase !== expected)
    throw new Error(`Standby ${action} did not reach its intended native phase`);
  return completed(after);
}
