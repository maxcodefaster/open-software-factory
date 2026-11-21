import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authSchema } from "./namespaces";

export const jwks = authSchema.table("jwks", {
  id: text("id").primaryKey().notNull(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClientAssertion = authSchema.table("oauthClientAssertion", {
  id: text("id").primaryKey().notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
});

export const scimConnectionBinding = authSchema.table(
  "scimConnectionBinding",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    connectionKey: text("connectionKey").notNull(),
    provisioningDomainId: text("provisioningDomainId").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    decommissionedAt: timestamp("decommissionedAt", { withTimezone: true }),
    decommissionStatus: text("decommissionStatus").default("active").notNull(),
    decommissionCursorUserId: text("decommissionCursorUserId"),
    decommissionReconciledUserCount: integer("decommissionReconciledUserCount")
      .default(0)
      .notNull(),
    decommissionBatchCount: integer("decommissionBatchCount").default(0).notNull(),
    decommissionRevision: integer("decommissionRevision").default(0).notNull(),
    decommissionCompletedAt: timestamp("decommissionCompletedAt", { withTimezone: true }),
    decommissionLeaseId: text("decommissionLeaseId"),
    decommissionLeaseExpiresAt: timestamp("decommissionLeaseExpiresAt", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimConnectionBinding_connectionId_idx").using(
      "btree",
      table.connectionId.asc().nullsLast(),
    ),
    unique("scimConnectionBinding_connectionKey_key").on(table.connectionKey),
  ],
);

export const authVerification = authSchema.table(
  "verification",
  {
    id: uuid("id").primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("auth_verification_identifier_idx").using("btree", table.identifier.asc().nullsLast()),
  ],
);

export const authSession = authSchema.table(
  "session",
  {
    id: uuid("id").primaryKey().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).defaultNow().notNull(),
    loginMethod: text("login_method")
      .$type<"password" | "sso" | "emergency" | "identity-test">()
      .default("password")
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("auth_session_user_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "session_user_id_fkey",
    }).onDelete("cascade"),
    unique("session_token_key").on(table.token),
    check(
      "session_login_method_check",
      sql`${table.loginMethod} = ANY (ARRAY['password'::text, 'sso'::text, 'emergency'::text, 'identity-test'::text])`,
    ),
  ],
);

export const authUser = authSchema.table(
  "user",
  {
    id: uuid("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [unique("user_email_key").on(table.email)],
);

export const authAccount = authSchema.table(
  "account",
  {
    id: uuid("id").primaryKey().notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("auth_account_user_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "account_user_id_fkey",
    }).onDelete("cascade"),
    unique("account_provider_id_account_id_key").on(table.providerId, table.accountId),
  ],
);

export const oauthClient = authSchema.table(
  "oauthClient",
  {
    id: text("id").primaryKey().notNull(),
    clientId: text("clientId").notNull(),
    clientSecret: text("clientSecret"),
    clientDiscoveryId: text("clientDiscoveryId"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("clientCredentialsScopes").array().default([]),
    userId: uuid("userId"),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris").array().notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris").array(),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: boolean("backchannelLogoutSessionRequired"),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    applicationType: text("applicationType"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes").array(),
    responseTypes: text("responseTypes").array(),
    requirePKCE: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean("dpopBoundAccessTokens").default(false),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("oauthClient_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "oauthClient_userId_fkey",
    }),
    unique("oauthClient_clientId_key").on(table.clientId),
  ],
);

export const oauthAccessToken = authSchema.table(
  "oauthAccessToken",
  {
    id: text("id").primaryKey().notNull(),
    token: text("token"),
    clientId: text("clientId").notNull(),
    sessionId: uuid("sessionId"),
    userId: uuid("userId"),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    refreshId: text("refreshId"),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    revoked: timestamp("revoked", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("oauthAccessToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthAccessToken_clientId_idx").using("btree", table.clientId.asc().nullsLast()),
    index("oauthAccessToken_refreshId_idx").using("btree", table.refreshId.asc().nullsLast()),
    index("oauthAccessToken_sessionId_idx").using("btree", table.sessionId.asc().nullsLast()),
    index("oauthAccessToken_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthAccessToken_clientId_fkey",
    }),
    foreignKey({
      columns: [table.refreshId],
      foreignColumns: [oauthRefreshToken.id],
      name: "oauthAccessToken_refreshId_fkey",
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [authSession.id],
      name: "oauthAccessToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "oauthAccessToken_userId_fkey",
    }),
    unique("oauthAccessToken_token_key").on(table.token),
  ],
);

export const oauthRefreshToken = authSchema.table(
  "oauthRefreshToken",
  {
    id: text("id").primaryKey().notNull(),
    token: text("token").notNull(),
    clientId: text("clientId").notNull(),
    sessionId: uuid("sessionId"),
    userId: uuid("userId").notNull(),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotatedAt", { withTimezone: true }),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: timestamp("rotationReplayExpiresAt", { withTimezone: true }),
    authTime: timestamp("authTime", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("oauthRefreshToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_clientId_idx").using("btree", table.clientId.asc().nullsLast()),
    index("oauthRefreshToken_sessionId_idx").using("btree", table.sessionId.asc().nullsLast()),
    index("oauthRefreshToken_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthRefreshToken_clientId_fkey",
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [authSession.id],
      name: "oauthRefreshToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "oauthRefreshToken_userId_fkey",
    }),
    unique("oauthRefreshToken_token_key").on(table.token),
  ],
);

export const oauthClientResource = authSchema.table(
  "oauthClientResource",
  {
    id: text("id").primaryKey().notNull(),
    clientId: text("clientId").notNull(),
    resourceId: text("resourceId").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("oauthClientResource_clientId_idx").using("btree", table.clientId.asc().nullsLast()),
    uniqueIndex("oauthClientResource_clientId_resourceId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
      table.resourceId.asc().nullsLast(),
    ),
    index("oauthClientResource_resourceId_idx").using("btree", table.resourceId.asc().nullsLast()),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthClientResource_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.resourceId],
      foreignColumns: [oauthResource.identifier],
      name: "oauthClientResource_resourceId_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthResource = authSchema.table(
  "oauthResource",
  {
    id: text("id").primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    accessTokenTtl: integer("accessTokenTtl"),
    refreshTokenTtl: integer("refreshTokenTtl"),
    signingAlgorithm: text("signingAlgorithm"),
    signingKeyId: text("signingKeyId"),
    allowedScopes: text("allowedScopes").array(),
    customClaims: jsonb("customClaims"),
    dpopBoundAccessTokensRequired: boolean("dpopBoundAccessTokensRequired").default(false),
    disabled: boolean("disabled").default(false),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
    policyVersion: integer("policyVersion").default(1),
    metadata: jsonb("metadata"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("oauthResource_identifier_key").on(table.identifier),
  ],
);

export const oauthConsent = authSchema.table(
  "oauthConsent",
  {
    id: text("id").primaryKey().notNull(),
    clientId: text("clientId").notNull(),
    userId: uuid("userId"),
    referenceId: text("referenceId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("oauthConsent_clientId_idx").using("btree", table.clientId.asc().nullsLast()),
    index("oauthConsent_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthConsent_clientId_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "oauthConsent_userId_fkey",
    }),
  ],
);

export const scimGroup = authSchema.table(
  "scimGroup",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    provisioningDomainId: text("provisioningDomainId").notNull(),
    revision: integer("revision").default(0).notNull(),
    displayName: text("displayName").notNull(),
    displayNameKey: text("displayNameKey").notNull(),
    externalId: text("externalId"),
    externalIdKey: text("externalIdKey"),
    orderKey: text("orderKey").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimGroup_connectionId_idx").using("btree", table.connectionId.asc().nullsLast()),
    index("scimGroup_provisioningDomainId_idx").using(
      "btree",
      table.provisioningDomainId.asc().nullsLast(),
    ),
    unique("scimGroup_displayNameKey_key").on(table.displayNameKey),
    unique("scimGroup_externalIdKey_key").on(table.externalIdKey),
    unique("scimGroup_orderKey_key").on(table.orderKey),
  ],
);

export const scimGroupMember = authSchema.table(
  "scimGroupMember",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    groupId: text("groupId").notNull(),
    scimUserId: text("scimUserId").notNull(),
    membershipKey: text("membershipKey").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimGroupMember_connectionId_idx").using("btree", table.connectionId.asc().nullsLast()),
    index("scimGroupMember_groupId_idx").using("btree", table.groupId.asc().nullsLast()),
    index("scimGroupMember_scimUserId_idx").using("btree", table.scimUserId.asc().nullsLast()),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [scimGroup.id],
      name: "scimGroupMember_groupId_fkey",
    }),
    foreignKey({
      columns: [table.scimUserId],
      foreignColumns: [scimUser.id],
      name: "scimGroupMember_scimUserId_fkey",
    }),
    unique("scimGroupMember_membershipKey_key").on(table.membershipKey),
  ],
);

export const scimUser = authSchema.table(
  "scimUser",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    provisioningDomainId: text("provisioningDomainId").notNull(),
    userId: uuid("userId").notNull(),
    connectionUserKey: text("connectionUserKey").notNull(),
    userName: text("userName").notNull(),
    userNameKey: text("userNameKey").notNull(),
    primaryEmail: text("primaryEmail").notNull(),
    workEmailValueIndex: text("workEmailValueIndex").notNull(),
    emailValueIndex: text("emailValueIndex").notNull(),
    displayName: text("displayName").notNull(),
    formattedName: text("formattedName").notNull(),
    givenName: text("givenName"),
    familyName: text("familyName"),
    serializedEmails: text("serializedEmails").notNull(),
    serializedAttributes: text("serializedAttributes"),
    externalId: text("externalId"),
    externalIdKey: text("externalIdKey"),
    active: boolean("active").notNull(),
    orderKey: text("orderKey").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimUser_connectionId_idx").using("btree", table.connectionId.asc().nullsLast()),
    index("scimUser_provisioningDomainId_idx").using(
      "btree",
      table.provisioningDomainId.asc().nullsLast(),
    ),
    index("scimUser_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "scimUser_userId_fkey",
    }),
    unique("scimUser_connectionUserKey_key").on(table.connectionUserKey),
    unique("scimUser_userNameKey_key").on(table.userNameKey),
    unique("scimUser_externalIdKey_key").on(table.externalIdKey),
    unique("scimUser_orderKey_key").on(table.orderKey),
  ],
);

export const scimIdentityTombstone = authSchema.table(
  "scimIdentityTombstone",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    provisioningDomainId: text("provisioningDomainId").notNull(),
    externalId: text("externalId").notNull(),
    externalIdKey: text("externalIdKey").notNull(),
    userId: uuid("userId").notNull(),
    profile: text("profile").notNull(),
    deletedAt: timestamp("deletedAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimIdentityTombstone_connectionId_idx").using(
      "btree",
      table.connectionId.asc().nullsLast(),
    ),
    index("scimIdentityTombstone_provisioningDomainId_idx").using(
      "btree",
      table.provisioningDomainId.asc().nullsLast(),
    ),
    index("scimIdentityTombstone_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "scimIdentityTombstone_userId_fkey",
    }),
    unique("scimIdentityTombstone_externalIdKey_key").on(table.externalIdKey),
  ],
);

export const scimProjectionGrant = authSchema.table(
  "scimProjectionGrant",
  {
    id: text("id").primaryKey().notNull(),
    connectionId: text("connectionId").notNull(),
    provisioningDomainId: text("provisioningDomainId").notNull(),
    scimUserId: text("scimUserId").notNull(),
    userId: uuid("userId").notNull(),
    sourceKind: text("sourceKind").notNull(),
    sourceId: text("sourceId").notNull(),
    sourceValue: text("sourceValue"),
    role: text("role").notNull(),
    grantKey: text("grantKey").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimProjectionGrant_connectionId_idx").using(
      "btree",
      table.connectionId.asc().nullsLast(),
    ),
    index("scimProjectionGrant_provisioningDomainId_idx").using(
      "btree",
      table.provisioningDomainId.asc().nullsLast(),
    ),
    index("scimProjectionGrant_scimUserId_idx").using("btree", table.scimUserId.asc().nullsLast()),
    index("scimProjectionGrant_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.scimUserId],
      foreignColumns: [scimUser.id],
      name: "scimProjectionGrant_scimUserId_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "scimProjectionGrant_userId_fkey",
    }),
    unique("scimProjectionGrant_grantKey_key").on(table.grantKey),
  ],
);

export const scimSubject = authSchema.table(
  "scimSubject",
  {
    id: text("id").primaryKey().notNull(),
    userId: uuid("userId").notNull(),
    profileSourceId: text("profileSourceId"),
    revision: integer("revision").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("scimSubject_profileSourceId_idx").using(
      "btree",
      table.profileSourceId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "scimSubject_userId_fkey",
    }),
    unique("scimSubject_userId_key").on(table.userId),
  ],
);

export const ssoProvider = authSchema.table(
  "ssoProvider",
  {
    id: text("id").primaryKey().notNull(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidcConfig"),
    samlConfig: text("samlConfig"),
    userId: uuid("userId"),
    providerId: text("providerId").notNull(),
    organizationId: text("organizationId"),
    domain: text("domain").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "ssoProvider_userId_fkey",
    }),
    unique("ssoProvider_providerId_key").on(table.providerId),
  ],
);
