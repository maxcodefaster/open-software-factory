import { z } from "zod";
import { createOpenBaoKV, type OpenBaoOptions } from "../secrets/openbao";

const importCredential = z
  .object({
    commandID: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    token: z.string().min(1).max(8192),
  })
  .strict();
export type ImportCredential = z.output<typeof importCredential>;
export type ImportSecrets = {
  configured: boolean;
  read(key: string): Promise<ImportCredential | undefined>;
  create(key: string, value: ImportCredential): Promise<void>;
  remove(key: string): Promise<void>;
};
export function createImportSecrets(options?: OpenBaoOptions): ImportSecrets {
  const store = createOpenBaoKV(options);
  return {
    configured: store.configured,
    read: (key) => store.read(key, importCredential),
    create: (key, value) => store.create(key, value, importCredential),
    remove: store.removeImport,
  };
}
