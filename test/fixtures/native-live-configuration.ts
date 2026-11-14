import { readFile, writeFile } from "node:fs/promises";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { requireNativeForgeOrigin } from "../../scripts/factory/native-installation";
import { nativeRuntimeArchitecture } from "../../packages/runtime-kubernetes/src/substrate-profile";

// A new owned control plane gets its own database attribution. This does not
// rewrite any retained installation, Actor binding or operator configuration.
export function requireNativeLiveHost(
  host = { platform: process.platform as string, uid: process.getuid?.() },
) {
  if (host.platform !== "linux" || host.uid !== 1000)
    throw Error("Live Factory runtime proof requires a Linux control plane running as UID 1000");
}

export function nativeLiveConfiguration(
  value: unknown,
  database: string,
  forge: Record<string, string | undefined>,
  host = { platform: process.platform as string, uid: process.getuid?.() },
) {
  requireNativeLiveHost(host);
  if (!/^owned_[a-f0-9]{32}$/.test(database))
    throw Error("Live Factory runtime proof requires its exactly owned database");
  const configuration = substrateInstallationConfiguration(value);
  if (configuration.deployment !== "fresh-workspaces")
    throw Error("Live Factory proof must use the normal fresh-workspaces Substrate path");
  nativeRuntimeArchitecture(configuration.runtime);
  if (configuration.connection.tokenFile === configuration.provisioner.tokenFile)
    throw Error("Live Factory proof requires separate native Owner and Editor credentials");
  requireNativeForgeOrigin(forge, configuration);
  return { ...configuration, database };
}

export async function saveNativeLiveConfiguration(file: string, value: unknown, retained: boolean) {
  const text = `${JSON.stringify(value)}\n`;
  if (retained) {
    if ((await readFile(file, "utf8")) !== text)
      throw Error("Retained native fixture configuration differs; recreate the owned fixture");
    return file;
  }
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
  return file;
}
