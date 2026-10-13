import { z } from "zod";
import {
  modelConnectionMetadata,
  modelConnectionWrite,
} from "../../../../packages/conversation-domain/src/model-connection";
import { createOpenBaoKV, type OpenBaoOptions } from "../secrets/openbao";

export const storedModelConnection = modelConnectionMetadata
  .extend({
    commandID: z.uuid(),
    connectionID: z.uuid(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    apiKey: modelConnectionWrite.shape.apiKey,
  })
  .strict();
export type StoredModelConnection = z.output<typeof storedModelConnection>;
export type ModelSecrets = {
  readonly configured: boolean;
  read(key: string): Promise<StoredModelConnection | undefined>;
  create(key: string, value: StoredModelConnection): Promise<void>;
};
export function createOpenBaoModelSecrets(input?: OpenBaoOptions): ModelSecrets {
  const store = createOpenBaoKV(input);
  function validate(key: string) {
    if (!/^models\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key))
      throw new Error("Invalid model secret identity");
    return key;
  }
  return {
    configured: store.configured,
    read: (key) => store.read(validate(key), storedModelConnection),
    create: (key, value) => store.create(validate(key), value, storedModelConnection),
  };
}
