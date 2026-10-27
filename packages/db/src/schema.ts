import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UsageCounters, UsagePurpose, UsageRate } from "../../conversation-domain/src/usage";
import type { ExecutionPolicy } from "../../conversation-domain/src/execution-policy";

export const authSchema = pgSchema("auth");

export const authUser = authSchema.table(
  "user",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auth_user_email_uidx").on(table.email)],
);

export const authSession = authSchema.table(
  "session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull().defaultNow(),
    loginMethod: text("login_method")
      .$type<"password" | "sso" | "emergency" | "identity-test">()
      .notNull()
      .default("password"),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("auth_session_token_uidx").on(table.token),
    index("auth_session_user_idx").on(table.userId),
  ],
);

export const authAccount = authSchema.table(
  "account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_account_user_idx").on(table.userId),
    uniqueIndex("auth_account_provider_account_uidx").on(table.providerId, table.accountId),
  ],
);

export const authVerification = authSchema.table(
  "verification",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

export const ssoProvider = authSchema.table("ssoProvider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidcConfig"),
  samlConfig: text("samlConfig"),
  userId: uuid("userId").references(() => authUser.id, { onDelete: "no action" }),
  providerId: text("providerId").notNull().unique(),
  organizationId: text("organizationId"),
  domain: text("domain").notNull(),
});

export const scimConnectionBinding = authSchema.table("scimConnectionBinding", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  connectionKey: text("connectionKey").notNull().unique(),
  provisioningDomainId: text("provisioningDomainId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  decommissionedAt: timestamp("decommissionedAt", { withTimezone: true }),
  decommissionStatus: text("decommissionStatus").notNull().default("active"),
  decommissionCursorUserId: text("decommissionCursorUserId"),
  decommissionReconciledUserCount: integer("decommissionReconciledUserCount").notNull().default(0),
  decommissionBatchCount: integer("decommissionBatchCount").notNull().default(0),
  decommissionRevision: integer("decommissionRevision").notNull().default(0),
  decommissionCompletedAt: timestamp("decommissionCompletedAt", { withTimezone: true }),
  decommissionLeaseId: text("decommissionLeaseId"),
  decommissionLeaseExpiresAt: timestamp("decommissionLeaseExpiresAt", { withTimezone: true }),
});

export const scimIdentityTombstone = authSchema.table("scimIdentityTombstone", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  provisioningDomainId: text("provisioningDomainId").notNull(),
  externalId: text("externalId").notNull(),
  externalIdKey: text("externalIdKey").notNull().unique(),
  userId: uuid("userId")
    .notNull()
    .references(() => authUser.id, { onDelete: "no action" }),
  profile: text("profile").notNull(),
  deletedAt: timestamp("deletedAt", { withTimezone: true }).notNull(),
});

export const scimSubject = authSchema.table("scimSubject", {
  id: text("id").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .unique()
    .references(() => authUser.id, { onDelete: "no action" }),
  profileSourceId: text("profileSourceId"),
  revision: integer("revision").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const scimUser = authSchema.table("scimUser", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  provisioningDomainId: text("provisioningDomainId").notNull(),
  userId: uuid("userId")
    .notNull()
    .references(() => authUser.id, { onDelete: "no action" }),
  connectionUserKey: text("connectionUserKey").notNull().unique(),
  userName: text("userName").notNull(),
  userNameKey: text("userNameKey").notNull().unique(),
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
  externalIdKey: text("externalIdKey").unique(),
  active: boolean("active").notNull(),
  orderKey: text("orderKey").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const scimProjectionGrant = authSchema.table("scimProjectionGrant", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  provisioningDomainId: text("provisioningDomainId").notNull(),
  scimUserId: text("scimUserId")
    .notNull()
    .references(() => scimUser.id, { onDelete: "no action" }),
  userId: uuid("userId")
    .notNull()
    .references(() => authUser.id, { onDelete: "no action" }),
  sourceKind: text("sourceKind").notNull(),
  sourceId: text("sourceId").notNull(),
  sourceValue: text("sourceValue"),
  role: text("role").notNull(),
  grantKey: text("grantKey").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const scimGroup = authSchema.table("scimGroup", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  provisioningDomainId: text("provisioningDomainId").notNull(),
  revision: integer("revision").notNull().default(0),
  displayName: text("displayName").notNull(),
  displayNameKey: text("displayNameKey").notNull().unique(),
  externalId: text("externalId"),
  externalIdKey: text("externalIdKey").unique(),
  orderKey: text("orderKey").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const scimGroupMember = authSchema.table("scimGroupMember", {
  id: text("id").primaryKey(),
  connectionId: text("connectionId").notNull(),
  groupId: text("groupId")
    .notNull()
    .references(() => scimGroup.id, { onDelete: "no action" }),
  scimUserId: text("scimUserId")
    .notNull()
    .references(() => scimUser.id, { onDelete: "no action" }),
  membershipKey: text("membershipKey").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export const oauthClient = authSchema.table("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  clientDiscoveryId: text("clientDiscoveryId"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skipConsent"),
  enableEndSession: boolean("enableEndSession"),
  subjectType: text("subjectType"),
  scopes: text("scopes").array(),
  clientCredentialsScopes: text("clientCredentialsScopes").array().default([]),
  userId: uuid("userId").references(() => authUser.id, { onDelete: "no action" }),
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
});

export const oauthResource = authSchema.table("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
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
});

export const oauthClientResource = authSchema.table("oauthClientResource", {
  id: text("id").primaryKey(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: text("resourceId")
    .notNull()
    .references(() => oauthResource.identifier, { onDelete: "cascade" }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("createdAt", { withTimezone: true }),
});

export const oauthRefreshToken = authSchema.table("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "no action" }),
  sessionId: uuid("sessionId").references(() => authSession.id, { onDelete: "set null" }),
  userId: uuid("userId")
    .notNull()
    .references(() => authUser.id, { onDelete: "no action" }),
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
});

export const oauthAccessToken = authSchema.table("oauthAccessToken", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "no action" }),
  sessionId: uuid("sessionId").references(() => authSession.id, { onDelete: "set null" }),
  userId: uuid("userId").references(() => authUser.id, { onDelete: "no action" }),
  referenceId: text("referenceId"),
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources").array(),
  requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
  refreshId: text("refreshId").references(() => oauthRefreshToken.id, { onDelete: "no action" }),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }),
  revoked: timestamp("revoked", { withTimezone: true }),
  confirmation: jsonb("confirmation"),
  scopes: text("scopes").array().notNull(),
});

export const oauthConsent = authSchema.table("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "no action" }),
  userId: uuid("userId").references(() => authUser.id, { onDelete: "no action" }),
  referenceId: text("referenceId"),
  resources: text("resources").array(),
  requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }),
});

export const oauthClientAssertion = authSchema.table("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
});

export const jwks = authSchema.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  ssoProvider,
  scimConnectionBinding,
  scimIdentityTombstone,
  scimSubject,
  scimUser,
  scimProjectionGrant,
  scimGroup,
  scimGroupMember,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  jwks,
};

export const factorySchema = pgSchema("factory");
export const ticketState = factorySchema.enum("ticket_state", [
  "inbox",
  "backlog",
  "ready",
  "in-progress",
  "cancelled",
  "done",
]);

export const project = factorySchema.table("project", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  desktopBackgroundKey: text("desktop_background_key").notNull(),
  repositoryUrl: text("repository_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  devcontainerPath: text("devcontainer_path").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const userUIPreference = factorySchema.table("user_ui_preference", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  desktopBackgroundKey: text("desktop_background_key").notNull().default("river-landscape"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembership = factorySchema.table(
  "project_membership",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    role: text("role").$type<"developer" | "product-contributor">().notNull(),
    manageProject: boolean("manage_project").notNull().default(false),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => authUser.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.userId] })],
);

export const accountAccess = factorySchema.table("account_access", {
  id: uuid("id").notNull().unique().defaultRandom(),
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  directoryDisabledAt: timestamp("directory_disabled_at", { withTimezone: true }),
  disabledBy: uuid("disabled_by").references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accessRevocation = factorySchema.table("access_revocation", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  processedVersion: bigint("processed_version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const forgeIdentityIntent = factorySchema.table("forge_identity_intent", {
  clientId: text("client_id").primaryKey(),
  redirectUri: text("redirect_uri").notNull(),
  intendedBy: uuid("intended_by")
    .notNull()
    .references(() => authUser.id),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
});

export const forgeConnection = factorySchema.table("forge_connection", {
  id: boolean("id").primaryKey().default(true),
  sourceName: text("source_name").notNull(),
  discoveryUrl: text("discovery_url").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  sourceId: bigint("source_id", { mode: "number" }),
  state: text("state").notNull(),
  intendedBy: uuid("intended_by")
    .notNull()
    .references(() => authUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
});

export const forgeAccountIntent = factorySchema.table("forge_account_intent", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id),
  username: text("username").notNull().unique(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  forgeUserId: bigint("forge_user_id", { mode: "number" }),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
});

export const forgeGrantIntent = factorySchema.table(
  "forge_grant_intent",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id),
    desired: boolean("desired").notNull(),
    confirmed: boolean("confirmed"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.userId] })],
);

export const forgeBranchIntent = factorySchema.table(
  "forge_branch_intent",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    branch: text("branch").notNull(),
    writers: text("writers").array().notNull(),
    merger: text("merger").notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.branch] })],
);

export const externalIdentity = factorySchema.table(
  "external_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    directorySubject: text("directory_subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [uniqueIndex("external_identity_issuer_subject_uidx").on(row.issuer, row.subject)],
);

export const identitySetup = factorySchema.table("identity_setup", {
  id: uuid("id").primaryKey(),
  baseVersion: bigint("base_version", { mode: "number" }).notNull(),
  metadata: jsonb("metadata").notNull(),
  fingerprint: text("fingerprint").notNull(),
  secretKey: text("secret_key").notNull(),
  createdBy: uuid("created_by").notNull(),
  state: text("state").notNull(),
  testedAt: timestamp("tested_at", { withTimezone: true }),
  testedUserId: uuid("tested_user_id"),
});

export const projectEnvironment = factorySchema.table(
  "project_environment",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"development" | "main-preview">().notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    manifest: jsonb("manifest").notNull(),
    secretKey: text("secret_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.environment] })],
);

export const environmentWrite = factorySchema.table("environment_write", {
  commandId: uuid("command_id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id),
  environment: text("environment").$type<"development" | "main-preview">().notNull(),
  baseVersion: bigint("base_version", { mode: "number" }).notNull(),
  fingerprint: text("fingerprint").notNull(),
  manifest: jsonb("manifest").notNull(),
  secretKey: text("secret_key").notNull().unique(),
  state: text("state").$type<"write-intended" | "committed" | "discarded">().notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => authUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
});

export const modelDefaults = factorySchema.table("model_defaults", {
  singleton: boolean("singleton").primaryKey().default(true),
  version: bigint("version", { mode: "number" }).notNull(),
  planningModelId: text("planning_model_id").notNull(),
  buildModelId: text("build_model_id").notNull(),
  roleRules: jsonb("role_rules"),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectModelSettings = factorySchema.table("project_model_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull(),
  planning: jsonb("planning").notNull(),
  build: jsonb("build").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personalModelSettings = factorySchema.table(
  "personal_model_settings",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    version: bigint("version", { mode: "number" }).notNull(),
    planningModelId: text("planning_model_id"),
    buildModelId: text("build_model_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.userId] })],
);

export const skillRevision = factorySchema.table("skill_revision", {
  id: uuid("id").primaryKey(),
  skillKey: text("skill_key").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  content: jsonb("content").notNull(),
  contentDigest: text("content_digest").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => authUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skillPublication = factorySchema.table("skill_publication", {
  revisionId: uuid("revision_id")
    .primaryKey()
    .references(() => skillRevision.id),
  published: boolean("published").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const systemSkillSettings = factorySchema.table("system_skill_settings", {
  singleton: boolean("singleton").primaryKey().default(true),
  version: bigint("version", { mode: "number" }).notNull(),
  planning: jsonb("planning").notNull(),
  build: jsonb("build").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectSkillSettings = factorySchema.table("project_skill_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull(),
  planning: jsonb("planning").notNull(),
  build: jsonb("build").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personalSkillSettings = factorySchema.table(
  "personal_skill_settings",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    version: bigint("version", { mode: "number" }).notNull(),
    planning: jsonb("planning"),
    build: jsonb("build"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.userId] })],
);

export const epic = factorySchema.table("epic", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull(),
  parentId: uuid("parent_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ticket = factorySchema.table("ticket", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull(),
  epicId: uuid("epic_id"),
  convertedToEpicId: uuid("converted_to_epic_id"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  state: ticketState("state").notNull().default("inbox"),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  trashedBy: uuid("trashed_by"),
  trashStopPending: boolean("trash_stop_pending").notNull().default(false),
  trashError: text("trash_error"),
});

export const ticketResponsibility = factorySchema.table("ticket_responsibility", {
  ticketId: uuid("ticket_id")
    .primaryKey()
    .references(() => ticket.id, { onDelete: "cascade" }),
  userId: uuid("user_id"),
  version: integer("version").notNull().default(1),
});

export const ticketFollow = factorySchema.table(
  "ticket_follow",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    following: boolean("following").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ticketId, table.userId] })],
);

export const ticketResponsibilityEvent = factorySchema.table("ticket_responsibility_event", {
  id: uuid("id").primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => ticket.id, { onDelete: "cascade" }),
  userId: uuid("user_id"),
  actorId: uuid("actor_id").notNull(),
  expectedVersion: integer("expected_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxReceipt = factorySchema.table(
  "inbox_receipt",
  {
    userId: uuid("user_id").notNull(),
    itemId: text("item_id").notNull(),
    seenEventId: text("seen_event_id"),
    archived: boolean("archived").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.userId, table.itemId] })],
);

export const ticketDependency = factorySchema.table(
  "ticket_dependency",
  {
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    prerequisiteId: uuid("prerequisite_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [primaryKey({ columns: [row.projectId, row.ticketId, row.prerequisiteId] })],
);

export const knowledgePageState = factorySchema.enum("knowledge_page_state", [
  "active",
  "archived",
]);

export const knowledgePage = factorySchema.table("knowledge_page", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  parentId: uuid("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  icon: text("icon").notNull().default("knowledge"),
  metadataVersion: bigint("metadata_version", { mode: "number" }).notNull().default(1),
  state: knowledgePageState("state").notNull().default("active"),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  currentRevisionId: uuid("current_revision_id"),
  currentBody: text("current_body").notNull(),
  generatedBody: text("generated_body").notNull(),
  sourceCommitSha: text("source_commit_sha").notNull(),
  citations: jsonb("citations").$type<Array<{ path: string; commitSha: string }>>().notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationMode = factorySchema.enum("conversation_mode", [
  "investigate",
  "plan",
  "build",
]);
export const conversationEntryKind = factorySchema.enum("conversation_entry_kind", [
  "user-message",
  "agent-message",
  "question",
  "answer",
  "requirement",
  "mode-change",
]);
export const conversationActor = factorySchema.enum("conversation_actor", [
  "user",
  "project-agent",
  "change-agent",
  "system",
]);

export const ticketConversation = factorySchema.table(
  "ticket_conversation",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id"),
    activeCodingContextId: uuid("active_coding_context_id"),
    mode: conversationMode("mode").notNull().default("investigate"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_conversation_ticket_uidx").on(table.ticketId),
    index("ticket_conversation_project_idx").on(table.projectId, table.createdBy),
  ],
);

export const conversationEntry = factorySchema.table(
  "conversation_entry",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    kind: conversationEntryKind("kind").notNull(),
    actor: conversationActor("actor").notNull(),
    mode: conversationMode("mode").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    citations: jsonb("citations")
      .$type<Array<{ source: "knowledge" | "ticket"; id: string; label: string }>>()
      .notNull(),
    inReplyToEntryId: uuid("in_reply_to_entry_id"),
    requirementRevisionId: uuid("requirement_revision_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_entry_ordinal_uidx").on(table.conversationId, table.ordinal),
    index("conversation_entry_conversation_idx").on(table.conversationId, table.createdAt),
  ],
);

export const usageOperation = factorySchema.table(
  "usage_operation",
  {
    id: text("id").primaryKey(),
    projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => authUser.id),
    purpose: text("purpose").$type<UsagePurpose>().notNull(),
    engine: text("engine").$type<"opencode" | "mastra">().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    rate: jsonb("rate").$type<UsageRate>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    outcome: text("outcome").$type<"completed" | "failed" | "interrupted" | "unknown">(),
  },
  (table) => [index("usage_operation_scope_time_idx").on(table.projectId, table.createdAt)],
);

export const usageEntry = factorySchema.table(
  "usage_entry",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => usageOperation.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    source: text("source").$type<"step" | "title" | "compaction" | "unobserved">().notNull(),
    outcome: text("outcome").$type<"completed" | "failed" | "interrupted" | "unknown">().notNull(),
    counters: jsonb("counters").$type<UsageCounters>().notNull(),
    nanoUsd: bigint("nano_usd", { mode: "bigint" }),
    knownNanoUsd: bigint("known_nano_usd", { mode: "bigint" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.eventId] }),
    index("usage_entry_time_idx").on(table.occurredAt),
  ],
);

export const usageReplayCursor = factorySchema.table(
  "usage_replay_cursor",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => usageOperation.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    startSequence: bigint("start_sequence", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.sessionId] })],
);

export const executionPolicy = factorySchema.table("execution_policy", {
  scope: text("scope").primaryKey(),
  version: bigint("version", { mode: "number" }).notNull(),
  policy: jsonb("policy").$type<ExecutionPolicy>().notNull(),
  timezone: text("timezone"),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const executionPolicyCommand = factorySchema.table("execution_policy_command", {
  commandId: uuid("command_id").primaryKey(),
  scope: text("scope").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => authUser.id),
  input: jsonb("input").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const codingPause = factorySchema.table("coding_pause", {
  turnId: uuid("turn_id").primaryKey(),
  reason: text("reason")
    .$type<"accounting-incomplete" | "coding-budget-used" | "finish-reserve-used">()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resumedByTurnId: uuid("resumed_by_turn_id"),
});
export const runtimeComputeWait = factorySchema.table("runtime_compute_wait", {
  attemptId: uuid("attempt_id").primaryKey(),
  reason: text("reason")
    .$type<
      "compute-capacity" | "accounting-incomplete" | "coding-budget-used" | "finish-reserve-used"
    >()
    .notNull()
    .default("compute-capacity"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const usageRateOverride = factorySchema.table(
  "usage_rate_override",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    rate: jsonb("rate").$type<UsageRate>(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => authUser.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.model] })],
);

export const learningSourceArtifact = factorySchema.table(
  "learning_source_artifact",
  {
    // agent_turn is SQL-owned, like agent_turn_skill. The baseline owns this FK.
    turnId: uuid("turn_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    reference: text("reference").notNull(),
    body: text("body").notNull(),
    truncated: boolean("truncated").notNull(),
  },
  (table) => [primaryKey({ columns: [table.turnId, table.ordinal] })],
);
export const learningPolicy = factorySchema.table("learning_policy", {
  scopeKey: text("scope_key").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => authUser.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  automaticSkills: boolean("automatic_skills").notNull().default(false),
  version: integer("version").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => authUser.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const learningReview = factorySchema.table("learning_review", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => authUser.id, { onDelete: "cascade" }),
  developerOnly: boolean("developer_only").notNull(),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => authUser.id),
  kind: text("kind").notNull(),
  rubric: text("rubric").notNull(),
  modelId: text("model_id").notNull(),
  modelConnection: jsonb("model_connection"),
  judgeKey: text("judge_key").notNull(),
  state: text("state").notNull(),
  input: jsonb("input").notNull(),
  inputDigest: text("input_digest").notNull(),
  result: jsonb("result"),
  calibrated: boolean("calibrated"),
  reason: text("reason"),
  ownerToken: uuid("owner_token").notNull(),
  ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const learningCase = factorySchema.table("learning_case", {
  id: text("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => authUser.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => authUser.id),
  developerOnly: boolean("developer_only").notNull(),
  activity: text("activity").notNull(),
  outcome: text("outcome").notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
  snapshot: jsonb("snapshot").notNull(),
  selected: boolean("selected").notNull(),
  batchId: uuid("batch_id").references(() => learningReview.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const learningProposal = factorySchema.table(
  "learning_proposal",
  {
    id: uuid("id").primaryKey(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => learningReview.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: jsonb("content").notNull(),
    state: text("state").notNull().default("proposed"),
    decisionId: uuid("decision_id").unique(),
    decidedBy: uuid("decided_by").references(() => authUser.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ticketId: uuid("ticket_id").references(() => ticket.id),
  },
  (table) => [uniqueIndex("learning_proposal_review_ordinal").on(table.reviewId, table.ordinal)],
);
export const learningCommand = factorySchema.table("learning_command", {
  id: uuid("id").primaryKey(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => authUser.id),
  input: jsonb("input").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const learningTrial = factorySchema.table(
  "learning_trial",
  {
    id: uuid("id").primaryKey(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => learningProposal.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => authUser.id),
    policyVersion: integer("policy_version").notNull(),
    modelId: text("model_id").notNull(),
    modelConnection: jsonb("model_connection"),
    judgeKey: text("judge_key").notNull(),
    rubric: text("rubric").notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    state: text("state").notNull().default("running"),
    result: jsonb("result"),
    reason: text("reason"),
    ownerToken: uuid("owner_token").notNull(),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("learning_trial_proposal_phase").on(table.proposalId, table.phase)],
);
export const learningTrialStep = factorySchema.table(
  "learning_trial_step",
  {
    trialId: uuid("trial_id")
      .notNull()
      .references(() => learningTrial.id, { onDelete: "cascade" }),
    stage: integer("stage").notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    state: text("state").notNull().default("running"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.trialId, table.stage] })],
);
export const learningApplication = factorySchema.table("learning_application", {
  id: uuid("id").primaryKey(),
  proposalId: uuid("proposal_id")
    .notNull()
    .unique()
    .references(() => learningProposal.id, { onDelete: "cascade" }),
  target: jsonb("target").notNull(),
  editDigest: text("edit_digest").notNull(),
  activation: jsonb("activation").notNull().default([]),
  appliedRevisionId: uuid("applied_revision_id").notNull(),
  appliedVersion: integer("applied_version").notNull(),
  appliedBy: uuid("applied_by")
    .notNull()
    .references(() => authUser.id),
  comparisonId: uuid("comparison_id").references(() => learningTrial.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  state: text("state").notNull().default("applied"),
  revertedRevisionId: uuid("reverted_revision_id"),
  revertedVersion: integer("reverted_version"),
  revertedBy: uuid("reverted_by").references(() => authUser.id),
  revertedComparisonId: uuid("reverted_comparison_id").references(() => learningTrial.id),
  revertedAt: timestamp("reverted_at", { withTimezone: true }),
});

export const readVersion = factorySchema.table(
  "read_version",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    audience: text("audience").notNull(),
    scope: text("scope").notNull(),
    resourceId: uuid("resource_id").notNull(),
    revision: uuid("revision").notNull().defaultRandom(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.audience, table.scope, table.resourceId] }),
    index("read_version_scope").on(table.scope, table.projectId),
  ],
);

export const knowledgePageOutline = factorySchema.table(
  "knowledge_page_outline",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => knowledgePage.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").notNull(),
    icon: text("icon").notNull(),
    metadataVersion: bigint("metadata_version", { mode: "number" }).notNull(),
    state: knowledgePageState("state").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    currentRevisionId: uuid("current_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("knowledge_page_outline_project").on(table.projectId, table.state)],
);
