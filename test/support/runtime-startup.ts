import { z } from "zod";

// These clocks end at visible Monaco text or a successful PTY command response,
// never at a ready Pod, a connected socket or an editor placeholder.
export function slice20StartupTargetFailures(measured: {
  loadedSourceMS?: number;
  executableTerminalMS: number;
  restartedTerminalMS: number;
}): string[] {
  const failures: string[] = [];
  for (const [name, actual, target] of [
    ["loaded source", measured.loadedSourceMS, 8500],
    ["executable Terminal", measured.executableTerminalMS, 21_500],
    ["stopped executable Terminal", measured.restartedTerminalMS, 18_500],
  ] as const) {
    if (actual === undefined && name === "loaded source") continue;
    if (actual === undefined || !Number.isFinite(actual) || actual < 0)
      failures.push(`${name}: invalid measurement`);
    else if (actual > target) failures.push(`${name}: ${actual} ms exceeds ${target} ms`);
  }
  return failures;
}

const phaseSchema = z.strictObject({
  phase: z.enum([
    "private-docker",
    "checkout",
    "devcontainer-configuration",
    "devcontainer-merged-configuration",
    "project-images",
    "browser-image",
    "devcontainer-start",
    "tool-injection",
    "process-start",
    "channel-readiness",
  ]),
  startedAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().min(0).max(86_400_000),
});
export type StartupMeasurement = z.infer<typeof phaseSchema>;

// Decode only Connector clock records from the runtime output envelope. Raw runtime
// output, App logs, assignments and credentials never enter timing artifacts.
export function startupMeasurements(raw: string) {
  const measurements = new Map<string, StartupMeasurement>();
  for (const line of raw.split("\n")) {
    let output = line;
    try {
      const envelope = z.object({ output: z.string() }).safeParse(JSON.parse(line));
      if (envelope.success) output = envelope.data.output;
    } catch {}
    for (const [, record] of output.matchAll(/factory-startup (\{[^\r\n{}]*\})/g)) {
      try {
        const parsed = phaseSchema.safeParse(JSON.parse(record ?? ""));
        if (parsed.success)
          measurements.set(`${parsed.data.phase}:${parsed.data.startedAt}`, parsed.data);
      } catch {}
    }
  }
  return [...measurements.values()];
}
