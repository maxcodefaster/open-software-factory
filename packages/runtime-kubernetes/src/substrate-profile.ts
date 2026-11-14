import { z } from "zod";
import pins from "../../../deploy/substrate/pins.json";

export const nativeArchitecture = z.enum(["amd64", "arm64"]);
export type NativeArchitecture = z.infer<typeof nativeArchitecture>;

/** Select from the observed immutable runtime, never the control-plane host. */
export function nativeRuntimeArchitecture(runtime: {
  version: { attributes: readonly { key: string; value: string }[] };
}): NativeArchitecture {
  const attributes = runtime.version.attributes.filter((item) => item.key === "architecture");
  if (attributes.length !== 1)
    throw Error("Native runtime requires exactly one supported architecture attribute");
  return nativeArchitecture.parse(attributes[0]?.value);
}

export function pinnedNativeSandboxSpec() {
  const asset = (architecture: NativeArchitecture) => ({
    gvisor: {
      url: pins.gvisor.architectures[architecture].url.replace(
        "https://storage.googleapis.com/",
        "gs://",
      ),
      sha256: pins.gvisor.architectures[architecture].sha256,
    },
  });
  return {
    sandboxClass: "gvisor",
    defaultVersion: pins.gvisor.version,
    versions: [
      {
        name: pins.gvisor.version,
        state: "Enabled",
        assets: { amd64: asset("amd64"), arm64: asset("arm64") },
      },
    ],
  };
}
