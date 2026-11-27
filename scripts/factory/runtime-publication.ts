export async function publishRuntimeImage(
  input: {
    dockerfile: string;
    target: string | undefined;
    repository: string;
    metadata: string;
    platform?: "linux/amd64" | "linux/arm64";
  },
  command: (args: string[]) => Promise<unknown>,
) {
  await command([
    "docker",
    "buildx",
    "build",
    "--provenance=false",
    ...(input.platform ? ["--platform", input.platform] : []),
    "--file",
    input.dockerfile,
    ...(input.target ? ["--target", input.target] : []),
    "--load",
    "--tag",
    `${input.repository}:local`,
    "--metadata-file",
    input.metadata,
    ".",
  ]);
  // Use the daemon's approved CA trust. BuildKit's
  // insecure registry exporter also permits HTTP against this HTTPS-only service.
  await command(["docker", "push", `${input.repository}:local`]);
}
