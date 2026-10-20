/**
 * Better Auth schema (Drizzle / PostgreSQL).
 *
 * Spec: §15 (security & multi-tenancy), §16.3 (better-auth with `organization`,
 * `apiKey` and `admin` plugins). Modelled after the MIT reference starter
 * (vendor/next-saas-stripe-starter) but adapted to this spec.
 *
 * Conventions:
 * - Text ids (Better Auth default) and `timestamptz` columns throughout.
 * - `organization` IS the workspace of §3.2/§12.1: the tenant root that every
 *   content row scopes to via `workspace_id`. Sessions are never shared across
 *   tenants; one engine process per tenant session.
 * - `member.role` / `invitation.role` carry the RBAC ladder of §15.2
 *   (owner > admin > editor > viewer). RBAC is enforced server-side on every
 *   endpoint; hiding UI elements is not enforcement.
 * - API keys are hashed at rest (§15.2: SHA-256 + pepper); the plaintext key
 *   exists only once, at creation time, and is never stored or logged.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Core Better Auth user table (§15.2 sessions). */
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // admin plugin (§16.3): platform-level role + ban tooling. `role` here is the
    // platform role ("admin"|"user"), distinct from workspace RBAC roles in `member`.
    role: text("role", { enum: ["admin", "user"] }),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
  },
  (t) => [uniqueIndex("user_email_unique").on(t.email)],
);

/** Core Better Auth session table. */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // admin plugin: audit trail for support impersonation.
    impersonatedBy: text("impersonated_by"),
    // organization plugin: the workspace this session is currently scoped to.
    // Plain text pointer (not an FK) — Better Auth manages it, and it is null-safe.
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [
    uniqueIndex("session_token_unique").on(t.token),
    index("session_user_id_idx").on(t.userId),
  ],
);

/** Core Better Auth account table (OAuth links + credential passwords). */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("account_user_id_idx").on(t.userId),
    uniqueIndex("account_provider_id_account_id_unique").on(t.providerId, t.accountId),
  ],
);

/** Core Better Auth verification table (email verification / magic links). */
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * organization plugin: a tenant workspace (§3.2/§12.1). The `slug` is used for
 * URLs; `metadata` holds the plan/trial fields until billing tables own them.
 */
export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("organization_slug_unique").on(t.slug)],
);

/**
 * organization plugin: workspace membership. `role` is the RBAC ladder of §15.2
 * (owner: delete workspace; admin: billing/invites; editor: runs + commands;
 * viewer: read + comment). unique(organization_id, user_id) prevents duplicates.
 */
export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "editor", "viewer"] })
      .notNull()
      .default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("member_organization_id_user_id_unique").on(t.organizationId, t.userId),
    index("member_user_id_idx").on(t.userId),
  ],
);

/** organization plugin: workspace invitations (email + role + status). */
export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "editor", "viewer"] }).notNull(),
    status: text("status", {
      enum: ["pending", "accepted", "rejected", "canceled"],
    })
      .notNull()
      .default("pending"),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("invitation_organization_id_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

/**
 * apiKey plugin (§15.2): personal API keys. `key` stores the SHA-256(+pepper)
 * hash only; `start` is the visible key prefix and `key_id` the lookup handle.
 * `scopes` (JSON string array, e.g. `["documents:read","runs:create"]`) is a
 * custom field mapped through the plugin config; `enabled = false` revokes.
 */
export const apiKey = pgTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    keyId: text("key_id").notNull(),
    start: text("start").notNull(),
    name: text("name").notNull(),
    scopes: text("scopes"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    // §15.2 per-key rate limits (§5.2 style budgets apply on top per workspace).
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(false),
    rateLimitTimeWindow: integer("rate_limit_time_window").notNull().default(60_000),
    rateLimitMax: integer("rate_limit_max").notNull().default(100),
    remainingRequests: integer("remaining_requests"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("api_key_key_id_unique").on(t.keyId),
    index("api_key_owner_id_idx").on(t.ownerId),
  ],
);
