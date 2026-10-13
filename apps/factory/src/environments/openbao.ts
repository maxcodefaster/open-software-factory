import { z } from "zod";
import {
  environmentBundle,
  type EnvironmentBundle,
} from "../../../../packages/project-domain/src/environment";
import { createOpenBaoKV, type OpenBaoOptions } from "../secrets/openbao";

const storedEnvironment = z
  .object({
    commandID: z.uuid(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    bundle: environmentBundle,
  })
  .strict();
export type StoredEnvironment = z.output<typeof storedEnvironment>;
export type EnvironmentSecrets = {
  readonly configured: boolean;
  read(key: string): Promise<StoredEnvironment | undefined>;
  create(key: string, value: StoredEnvironment): Promise<void>;
  renew?(): Promise<void>;
};

export function createOpenBaoEnvironmentSecrets(input?: OpenBaoOptions): EnvironmentSecrets {
  const store = createOpenBaoKV(input);
  function validate(key: string) {
    if (!/^projects\/[0-9a-f-]{36}\/(development|main-preview)\/[0-9a-f-]{36}$/.test(key))
      throw new Error("Invalid environment secret identity");
    return key;
  }
  return {
    configured: store.configured,
    read: (key) => store.read(validate(key), storedEnvironment),
    create: (key, value) => store.create(validate(key), value, storedEnvironment),
    renew: store.renew,
  };
}

export const emptyEnvironment: EnvironmentBundle = { variables: [], registries: [] };
