export type LifecycleSample = {
  pauseMS: number;
  resumeToHealthyMS: number;
  resumeToReadyMS?: number;
  beforeAnonBytes: number;
  afterAnonBytes: number;
  preserved: boolean;
};

export function percentile(values: readonly number[], fraction: number) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("A percentile requires finite nonnegative samples");
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error("Percentile must be in (0, 1]");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] as number;
}

export function summarizeLifecycle(samples: readonly LifecycleSample[]) {
  if (!samples.length) throw new Error("No lifecycle samples were recorded");
  const distribution = (values: number[]) => ({
    medianMS: percentile(values, 0.5),
    p95MS: percentile(values, 0.95),
    minMS: Math.min(...values),
    maxMS: Math.max(...values),
  });
  const readySamples = samples.flatMap((sample) =>
    sample.resumeToReadyMS === undefined ? [] : [sample.resumeToReadyMS],
  );
  if (readySamples.length !== 0 && readySamples.length !== samples.length)
    throw new Error("App-ready measurements must cover every lifecycle sample or none");
  return {
    samples: samples.length,
    successfulRestores: samples.filter((sample) => sample.preserved).length,
    pause: distribution(samples.map((sample) => sample.pauseMS)),
    resumeToHealthy: distribution(samples.map((sample) => sample.resumeToHealthyMS)),
    ...(readySamples.length ? { resumeToReady: distribution(readySamples) } : {}),
    anonymousRAMReleased: samples.every((sample) => sample.afterAnonBytes === 0),
  };
}
