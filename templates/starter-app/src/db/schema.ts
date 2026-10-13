import { pgTable, text, timestamp, uuid, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";

const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    ...dates(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);
export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...dates(),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_index").on(table.userId),
  ],
);
export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...dates(),
  },
  (table) => [
    uniqueIndex("account_provider_unique").on(table.providerId, table.accountId),
    index("account_user_index").on(table.userId),
  ],
);
export const verification = pgTable("verification", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...dates(),
});
