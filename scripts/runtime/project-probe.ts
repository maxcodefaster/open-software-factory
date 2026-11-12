export function projectStateProbeArguments(
  containerID: string,
  nodeEnvironment: readonly string[],
) {
  if (!/^[a-f0-9]{64}$/.test(containerID))
    throw new Error("Project state probe requires the selected immutable container identity");
  return [
    "docker",
    "exec",
    ...nodeEnvironment,
    containerID,
    "node",
    "-e",
    "fetch('http://localhost:4321/state').then(r=>{if(!r.ok)throw Error('state');return r.text()}).then(console.log)",
  ];
}
