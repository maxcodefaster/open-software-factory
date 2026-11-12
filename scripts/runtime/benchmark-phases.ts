import { z } from "zod";

const phaseEvent = z.strictObject({
  schema: z.literal(1),
  pid: z.number().int().positive(),
  phase: z.string().regex(/^[a-z0-9._-]{1,64}$/),
  started_at: z.iso.datetime({ offset: true }),
  elapsed_ms: z.number().finite().nonnegative(),
  failed: z.boolean(),
});

export function readNativePhases(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("factorybox-phase ") && line.length <= 512)
    .flatMap((line) => {
      try {
        const result = phaseEvent.safeParse(JSON.parse(line.slice("factorybox-phase ".length)));
        return result.success ? [result.data] : [];
      } catch {
        return [];
      }
    });
}

export function summarizeNativePhases(stderr: readonly string[]) {
  const phases = new Map<
    string,
    { count: number; failed: number; totalMS: number; maxMS: number }
  >();
  for (const output of stderr)
    for (const event of readNativePhases(output)) {
      const value = phases.get(event.phase) ?? { count: 0, failed: 0, totalMS: 0, maxMS: 0 };
      value.count++;
      value.failed += Number(event.failed);
      value.totalMS += event.elapsed_ms;
      value.maxMS = Math.max(value.maxMS, event.elapsed_ms);
      phases.set(event.phase, value);
    }
  return [...phases].map(([phase, value]) => ({
    phase,
    ...value,
    meanMS: value.totalMS / value.count,
  }));
}
