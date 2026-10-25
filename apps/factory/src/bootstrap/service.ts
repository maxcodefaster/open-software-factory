import {
  bootstrapSchema,
  sessionSchema,
  type Bootstrap,
  type UIPreference,
} from "../api-contracts";

export function createBootstrapService(options: {
  policy(): Bootstrap["identity"];
  preference(userID: string): Promise<UIPreference>;
  planningCacheURL: string;
  forgeOrigins: NonNullable<Bootstrap["forgeOrigins"]>;
  modelAvailability(): Promise<boolean>;
}) {
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
        forgeOrigins: options.forgeOrigins,
        modelRelayConfigured: await options.modelAvailability(),
      });
    },
  };
}
