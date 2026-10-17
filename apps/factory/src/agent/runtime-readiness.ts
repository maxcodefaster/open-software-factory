import { CommandError } from "../command-error";

type BuildSandboxObservation = {
  active: boolean;
  runtimeAttemptID: string | null;
  runtimeState: string | null;
};

export async function waitForBuildSandbox(
  attemptID: string,
  observe: () => Promise<BuildSandboxObservation>,
  closed: () => boolean,
  wait: () => Promise<unknown> = () => Bun.sleep(1_000),
) {
  // Runtime creation owns its bounded preparation operations. A second,
  // unrelated poll limit must not fail a still-progressing cold Sandbox.
  // No OpenCode mutation or inference is admitted while this wait continues.
  while (!closed()) {
    const current = await observe();
    if (!current.active) throw new CommandError("conflict", "Implementation startup was stopped");
    if (current.runtimeAttemptID !== attemptID)
      throw new CommandError(
        "conflict",
        "The recorded Sandbox generation changed before Build dispatch",
      );
    if (current.runtimeState === "ready")
      return { runtimeAttemptID: attemptID, runtimeState: "ready" as const };
    if (["failed", "stopped", "cleanup-failed"].includes(current.runtimeState ?? ""))
      throw new Error("Ticket Sandbox failed before OpenCode became ready");
    await wait();
  }
  throw new CommandError("conflict", "Implementation startup was stopped");
}
