// Controlled tool/Forge inputs only. Native installation selection belongs to
// the explicit Substrate fixture; no legacy worker tuple is commissioned here.
export const ownedRuntimeConfiguration = {
  FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
  FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
  FACTORY_FORGEJO_OWNER: "owned-runtime-fixture",
};

export function installOwnedRuntimeConfiguration() {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ownedRuntimeConfiguration)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
