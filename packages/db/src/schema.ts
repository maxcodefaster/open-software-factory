import * as auth from "./schema/auth";

export * from "./schema/access";
export * from "./schema/attachments";
export * from "./schema/auth";
export * from "./schema/coding";
export * from "./schema/conversations";
export * from "./schema/delivery";
export * from "./schema/enums";
export * from "./schema/environments";
export * from "./schema/installation";
export * from "./schema/knowledge";
export * from "./schema/learning";
export * from "./schema/mcp";
export * from "./schema/models";
export * from "./schema/monitoring";
export * from "./schema/namespaces";
export * from "./schema/operations";
export * from "./schema/projections";
export * from "./schema/projects";
export * from "./schema/releases";
export * from "./schema/review";
export * from "./schema/runtime";
export * from "./schema/skills";
export * from "./schema/tickets";
export * from "./schema/usage";
export * from "./schema/workspace";

export const betterAuthSchema = {
  user: auth.authUser,
  session: auth.authSession,
  account: auth.authAccount,
  verification: auth.authVerification,
  ssoProvider: auth.ssoProvider,
  scimConnectionBinding: auth.scimConnectionBinding,
  scimIdentityTombstone: auth.scimIdentityTombstone,
  scimSubject: auth.scimSubject,
  scimUser: auth.scimUser,
  scimProjectionGrant: auth.scimProjectionGrant,
  scimGroup: auth.scimGroup,
  scimGroupMember: auth.scimGroupMember,
  oauthClient: auth.oauthClient,
  oauthResource: auth.oauthResource,
  oauthClientResource: auth.oauthClientResource,
  oauthRefreshToken: auth.oauthRefreshToken,
  oauthAccessToken: auth.oauthAccessToken,
  oauthConsent: auth.oauthConsent,
  oauthClientAssertion: auth.oauthClientAssertion,
  jwks: auth.jwks,
};
