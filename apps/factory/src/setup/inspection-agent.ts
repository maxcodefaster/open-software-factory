export async function inspectConfiguration(
  input: Parameters<typeof import("./inspection-engine").inspectConfiguration>[0],
) {
  input.signal.throwIfAborted();
  const { inspectConfiguration: inspect } = await import("./inspection-engine");
  input.signal.throwIfAborted();
  return inspect(input);
}
