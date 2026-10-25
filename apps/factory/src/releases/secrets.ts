import { z } from "zod";
import { createOpenBaoKV, type OpenBaoOptions } from "../secrets/openbao";

const credential = z
  .object({ username: z.string(), password: z.string(), token: z.string().optional() })
  .strict();
export type ReleaseCredential = z.output<typeof credential>;
export type ReleaseSecrets = {
  configured: boolean;
  read(key: string): Promise<ReleaseCredential | undefined>;
  create(key: string, value: ReleaseCredential): Promise<void>;
};
export function createReleaseSecrets(options?: OpenBaoOptions): ReleaseSecrets {
  const store = createOpenBaoKV(options);
  return {
    configured: store.configured,
    read: (key) => store.read(key, credential),
    create: (key, value) => store.create(key, value, credential),
  };
}
