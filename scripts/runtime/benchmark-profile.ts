export const factoryboxExecutable = "/opt/factorybox/factorybox";

export function profiledArguments(args: readonly string[], enabled: boolean) {
  if (!enabled) return [...args];
  const index = args.indexOf(factoryboxExecutable);
  if (index < 0 || !args.slice(0, index).includes("exec")) return [...args];
  return [...args.slice(0, index), "env", "FACTORYBOX_TRACE_PHASES=1", ...args.slice(index)];
}

export function benchmarkCommandKind(args: readonly string[]) {
  const binary = args.indexOf(factoryboxExecutable);
  if (binary >= 0) {
    const commands = new Set([
      "worker-status",
      "capacity",
      "start",
      "state",
      "pause",
      "resume",
      "delete",
      "retire-checkpoint",
      "retire-resume",
      "retire-sandbox",
    ]);
    return `factorybox:${args.slice(binary + 1).find((value) => commands.has(value)) ?? "other"}`;
  }
  if (args.includes("exec")) return "kubernetes:exec";
  for (const verb of ["get", "create", "delete", "wait", "patch"])
    if (args.includes(verb)) return `kubernetes:${verb}`;
  return "other";
}

export function benchmarkMemoryMiB(value: string | undefined) {
  const mib = Number(value ?? 256);
  if (!Number.isInteger(mib) || mib < 64 || mib > 1536)
    throw new Error("FACTORY_BENCHMARK_MEMORY_MIB must be an integer from 64 to 1536");
  return mib;
}
