export type ComputeClass = "development" | "staging" | "verification" | "prebuild" | "publication";

export function computeReservation(kind: ComputeClass) {
  return kind === "staging"
    ? { sandboxes: 1, cpuMilli: 100, memoryMiB: 256 }
    : kind === "verification"
      ? { sandboxes: 1, cpuMilli: 250, memoryMiB: 768 }
      : { sandboxes: 1, cpuMilli: 500, memoryMiB: 1024 };
}
