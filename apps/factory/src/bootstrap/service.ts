import { createHmac } from "node:crypto";
import { sessionSchema } from "../access/contracts";
import type { UIPreference } from "../preferences/contracts";
import { type Bootstrap, bootstrapSchema } from "./contracts";

export function createBootstrapService(options: {
  policy(): Bootstrap["identity"];
  preference(userID: string): Promise<UIPreference>;
  planningCacheURL: string;
  signingKey: string;
  planningCacheEpoch?: string;
  forgeOrigins: NonNullable<Bootstrap["forgeOrigins"]>;
  modelAvailability(): Promise<boolean>;
}) {
  // The bootstrap administrator ID and public origin can recur in a fresh
  // installation. Neither may select another installation's offline replica.
  const planningCacheHmac = createHmac("sha256", options.signingKey).update(
    "factory-planning-cache-v1",
  );
  // A restored deployment can retain its signing key but must use a separate replica.
  if (options.planningCacheEpoch !== undefined)
    planningCacheHmac.update("\0").update(options.planningCacheEpoch);
  const planningCacheScope = planningCacheHmac.digest("hex");
  return {
    modelAvailability: options.modelAvailability,
    async get(rawSession: unknown): Promise<Bootstrap> {
      // Auth's internal session contains tokens and expiry metadata. The UI
      // receives only this public projection, not the auth SDK's native object.
      const session = sessionSchema.nullable().parse(rawSession);
      return bootstrapSchema.parse({
        session,
        identity: options.policy(),
        uiPreference: session
          ? await options.preference(session.user.id)
          : { desktopBackgroundKey: "river-landscape" },
        zeroCacheURL: options.planningCacheURL,
        planningCacheScope,
        forgeOrigins: options.forgeOrigins,
        modelRelayConfigured: await options.modelAvailability(),
      });
    },
  };
}
