// Shared types for isolated data-service restore rehearsals.
import type { Output, RunOptions } from "../owned-client-process";

export type Digest = { rows: number; sha256: string };
export type FileWitness = { path: string; bytes: number; sha256: string; link?: string };

export type Source = {
  chartRevision: string;
  applicationRevision: string;
  namespace: string;
  namespaceUID: string;
  release: string;
  factoryOrigin: string;
  forgejoOrigin: string;
  storageClass: string;
};

export type SourceManifest = {
  readonly chartRevision: string;
  readonly applicationRevision: string;
  readonly requiredStateFiles: readonly string[];
};

export type Witnesses = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  provenance: "independent-source-observation";
  parts: Record<string, string>;
  postgres: Record<string, Digest>;
  forgejo: { tables: Record<string, Digest>; files: FileWitness[]; repositories: string[] };
  state: {
    files: FileWitness[];
    excludedProvisionerPaths: string[];
    credentialReview: "no-native-provisioner-material-in-included-files";
  };
  objects: FileWitness[];
  openbao: { path: string; sha256: string }[];
};

export type Fixture = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  privateRoot: string;
  evidenceDirectory: string;
  docker: { host: string; daemonID: string; platform: string };
  retained: { paths: string[]; containers: string[]; volumes: string[]; networks: string[] };
  images: Record<string, string>;
  limits: {
    memoryMiB: number;
    cpus: number;
    pids: number;
    tmpfsMiB: number;
    commandTimeoutSeconds: number;
    requiredDiskBytes: number;
    availableDiskBytes: number;
  };
};

export type LoadedFixture = Fixture & { witnesses: Witnesses; witnessDigest: string };

export type Execute = (
  command: string[],
  options?: RunOptions & { env?: Record<string, string> },
) => Promise<Output>;

export type Kind = "network" | "volume" | "container";

export type Resource = {
  kind: Kind;
  key: string;
  name: string;
  id: string | null;
  created: string | null;
  state: "planned" | "confirmed" | "removed" | "unconfirmed";
};

export type Journal = {
  schema: 1;
  owner: string;
  run: string;
  source: Source;
  set: string;
  daemonID: string;
  resources: Resource[];
};

export type ComponentName = "postgres" | "forgejo" | "objects" | "openbao" | "state";
export type ComponentStatus = "not-run" | "passed" | "failed";

export type Receipt = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  status: "incomplete" | "data-services-passed";
  components: Record<ComponentName, ComponentStatus>;
  cleanup: "confirmed" | "unconfirmed";
  nativeActivation: "not-run-not-qualified";
  limits: Fixture["limits"];
  witnessDigest: string;
};

export type ComponentOutcome = {
  status: "passed" | "failed";
  fatal: boolean;
};

export type DockerRunner = {
  readonly state: { fatal: boolean };
  readonly controlMount: string[];
  readonly inputMount: string[];
  get(key: string): Resource;
  name(key: string): string;
  volume(key: string, target: string, readonly?: boolean): string[];
  command(args: string[], input?: string, env?: Record<string, string>): Promise<string>;
  create(key: string, args?: string[], env?: Record<string, string>): Promise<void>;
  container(
    key: string,
    image: string,
    args: string[],
    entrypoint: string,
    tail: string[],
    env?: Record<string, string>,
  ): Promise<void>;
  exec(key: string, script: string, shell?: string): Promise<string>;
};
