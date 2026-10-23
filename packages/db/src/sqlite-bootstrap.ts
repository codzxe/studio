/**
 * SQLite bootstrap (W1-02) — idempotent CREATE TABLE IF NOT EXISTS for every
 * table of the sqlite twin (`./schema-sqlite.ts`), plus the seed-relevant
 * DB defaults (status flags, timestamps as (unixepoch('subsec') * 1000) ms).
 *
 * WHEN THIS RUNS: once per dev database open. `createSqliteDb()` calls it by
 * default; it is safe to call again at any time (everything is IF NOT EXISTS —
 * pinned by tests/sqlite/bootstrap.test.ts running it twice).
 *
 * WHAT THIS IS NOT: this is NOT a migration system. Dev sqlite databases are
 * THROWAWAY — delete the file and it rebuilds. PRODUCTION is Postgres with the
 * canonical forward-only drizzle migrations in `drizzle/` (see README.md
 * "Dual dialect"); schema changes go: pg twin first, then REGENERATE this file
 * via drizzle-kit over the sqlite twin (scratch config — see the W1-02 worklog
 * entry); never hand-edit applied pg migrations.
 *
 * DDL provenance: generated with drizzle-kit 0.31.11 (dialect: sqlite) over
 * `./schema-sqlite.ts`, ordered parent-first and converted to IF NOT EXISTS.
 * Statement count is pinned by SQLITE_BOOTSTRAP_STATEMENTS + the twin test.
 */

import type Database from "better-sqlite3";

/** One statement per entry; parents before children, indexes after their table. */
const BOOTSTRAP_DDL: readonly string[] = [
"CREATE TABLE IF NOT EXISTS `user` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`email` text NOT NULL,\n\t`email_verified` integer DEFAULT false NOT NULL,\n\t`image` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`role` text,\n\t`banned` integer DEFAULT false,\n\t`ban_reason` text,\n\t`ban_expires` integer\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `user_email_unique` ON `user` (`email`);",
  "CREATE INDEX IF NOT EXISTS `user_email_idx` ON `user` (`email`);",
  "CREATE TABLE IF NOT EXISTS `session` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`token` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`ip_address` text,\n\t`user_agent` text,\n\t`user_id` text NOT NULL,\n\t`active_organization_id` text,\n\t`impersonated_by` text,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `session_token_unique` ON `session` (`token`);",
  "CREATE INDEX IF NOT EXISTS `session_user_idx` ON `session` (`user_id`);",
  "CREATE TABLE IF NOT EXISTS `account` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`account_id` text NOT NULL,\n\t`provider_id` text NOT NULL,\n\t`user_id` text NOT NULL,\n\t`access_token` text,\n\t`refresh_token` text,\n\t`id_token` text,\n\t`access_token_expires_at` integer,\n\t`refresh_token_expires_at` integer,\n\t`scope` text,\n\t`password` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE INDEX IF NOT EXISTS `account_user_idx` ON `account` (`user_id`);",
  "CREATE TABLE IF NOT EXISTS `verification` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`identifier` text NOT NULL,\n\t`value` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS `verification_identifier_idx` ON `verification` (`identifier`);",
  "CREATE TABLE IF NOT EXISTS `organization` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`slug` text NOT NULL,\n\t`logo` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`metadata` text\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `organization_slug_unique` ON `organization` (`slug`);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `organization_slug_uniq` ON `organization` (`slug`);",
  "CREATE TABLE IF NOT EXISTS `member` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`organization_id` text NOT NULL,\n\t`user_id` text NOT NULL,\n\t`role` text DEFAULT 'member' NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE INDEX IF NOT EXISTS `member_organization_idx` ON `member` (`organization_id`);",
  "CREATE INDEX IF NOT EXISTS `member_user_idx` ON `member` (`user_id`);",
  "CREATE TABLE IF NOT EXISTS `invitation` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`organization_id` text NOT NULL,\n\t`email` text NOT NULL,\n\t`role` text,\n\t`status` text DEFAULT 'pending' NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`inviter_id` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE INDEX IF NOT EXISTS `invitation_organization_idx` ON `invitation` (`organization_id`);",
  "CREATE INDEX IF NOT EXISTS `invitation_email_idx` ON `invitation` (`email`);",
  "CREATE TABLE IF NOT EXISTS `apikey` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`config_id` text DEFAULT 'default' NOT NULL,\n\t`name` text,\n\t`start` text,\n\t`reference_id` text NOT NULL,\n\t`prefix` text,\n\t`key` text NOT NULL,\n\t`refill_interval` integer,\n\t`refill_amount` integer,\n\t`last_refill_at` integer,\n\t`enabled` integer DEFAULT true,\n\t`rate_limit_enabled` integer DEFAULT true,\n\t`rate_limit_time_window` integer DEFAULT 86400000,\n\t`rate_limit_max` integer DEFAULT 10,\n\t`request_count` integer DEFAULT 0,\n\t`remaining` integer,\n\t`last_request` integer,\n\t`expires_at` integer,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`permissions` text,\n\t`metadata` text\n);",
  "CREATE INDEX IF NOT EXISTS `apikey_reference_idx` ON `apikey` (`reference_id`);",
  "CREATE INDEX IF NOT EXISTS `apikey_key_idx` ON `apikey` (`key`);",
  "CREATE TABLE IF NOT EXISTS `projects` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`workspace_id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`slug` text NOT NULL,\n\t`description` text,\n\t`thumbnail_url` text,\n\t`archived` integer DEFAULT false NOT NULL,\n\t`current_version_id` text,\n\t`created_by` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`deleted_at` integer,\n\tFOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `projects_workspace_updated_idx` ON `projects` (`workspace_id`,\"updated_at\" desc);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `projects_workspace_slug_uniq` ON `projects` (`workspace_id`,`slug`);",
  "CREATE INDEX IF NOT EXISTS `projects_current_version_idx` ON `projects` (`current_version_id`);",
  "CREATE TABLE IF NOT EXISTS `project_versions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`project_id` text NOT NULL,\n\t`version` integer NOT NULL,\n\t`parent_version_id` text,\n\t`object_key` text NOT NULL,\n\t`sha256` text NOT NULL,\n\t`size_bytes` integer NOT NULL,\n\t`label` text,\n\t`agent_run_id` text,\n\t`created_by` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `project_versions_project_idx` ON `project_versions` (`project_id`,\"version\" desc);",
  "CREATE INDEX IF NOT EXISTS `project_versions_project_sha_idx` ON `project_versions` (`project_id`,`sha256`);",
  "CREATE INDEX IF NOT EXISTS `project_versions_parent_idx` ON `project_versions` (`parent_version_id`);",
  "CREATE TABLE IF NOT EXISTS `project_leases` (\n\t`project_id` text PRIMARY KEY NOT NULL,\n\t`user_id` text NOT NULL,\n\t`session_id` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE TABLE IF NOT EXISTS `assets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`workspace_id` text NOT NULL,\n\t`project_id` text,\n\t`name` text NOT NULL,\n\t`mime` text NOT NULL,\n\t`size_bytes` integer NOT NULL,\n\t`sha256` text NOT NULL,\n\t`object_key` text NOT NULL,\n\t`width` integer,\n\t`height` integer,\n\t`duration_ticks` integer,\n\t`created_by` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `assets_workspace_created_idx` ON `assets` (`workspace_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `assets_workspace_sha_idx` ON `assets` (`workspace_id`,`sha256`);",
  "CREATE INDEX IF NOT EXISTS `assets_project_idx` ON `assets` (`project_id`);",
  "CREATE TABLE IF NOT EXISTS `agent_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`project_id` text NOT NULL,\n\t`created_by` text NOT NULL,\n\t`title` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `agent_threads_project_idx` ON `agent_threads` (`project_id`,\"updated_at\" desc);",
  "CREATE TABLE IF NOT EXISTS `agent_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`role` text NOT NULL,\n\t`content_json` text NOT NULL,\n\t`run_id` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE INDEX IF NOT EXISTS `agent_messages_thread_created_idx` ON `agent_messages` (`thread_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `agent_messages_run_idx` ON `agent_messages` (`run_id`);",
  "CREATE TABLE IF NOT EXISTS `agent_runs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`project_id` text NOT NULL,\n\t`model` text NOT NULL,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`plan_json` text,\n\t`reserved_credits` integer DEFAULT 0 NOT NULL,\n\t`committed_credits` integer DEFAULT 0 NOT NULL,\n\t`base_version_id` text,\n\t`result_version_id` text,\n\t`applied_at` integer,\n\t`applied_batch_sha256` text,\n\t`applied_version_id` text,\n\t`undone_at` integer,\n\t`undone_by` text,\n\t`error_code` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`completed_at` integer,\n\tFOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`base_version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE set null,\n\tFOREIGN KEY (`applied_version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE set null,\n\tFOREIGN KEY (`undone_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null\n);",
  "CREATE INDEX IF NOT EXISTS `agent_runs_thread_idx` ON `agent_runs` (`thread_id`);",
  "CREATE INDEX IF NOT EXISTS `agent_runs_project_idx` ON `agent_runs` (`project_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `agent_runs_status_idx` ON `agent_runs` (`status`);",
  "CREATE TABLE IF NOT EXISTS `agent_steps` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`run_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`tool` text NOT NULL,\n\t`args_json` text,\n\t`result_json` text,\n\t`command_batch_json` text,\n\t`status` text DEFAULT 'pending' NOT NULL,\n\t`duration_ms` integer,\n\tFOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `agent_steps_run_seq_uniq` ON `agent_steps` (`run_id`,`seq`);",
  "CREATE TABLE IF NOT EXISTS `credit_ledger` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`workspace_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`amount` integer NOT NULL,\n\t`balance_after` integer NOT NULL,\n\t`run_id` text,\n\t`render_id` text,\n\t`idempotency_key` text NOT NULL,\n\t`metadata` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `credit_ledger_idempotency_uniq` ON `credit_ledger` (`idempotency_key`);",
  "CREATE INDEX IF NOT EXISTS `credit_ledger_workspace_created_idx` ON `credit_ledger` (`workspace_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `credit_ledger_run_idx` ON `credit_ledger` (`run_id`);",
  "CREATE INDEX IF NOT EXISTS `credit_ledger_render_idx` ON `credit_ledger` (`render_id`);",
  "CREATE TABLE IF NOT EXISTS `renders` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`project_id` text NOT NULL,\n\t`version_id` text NOT NULL,\n\t`comp_id` text NOT NULL,\n\t`format` text NOT NULL,\n\t`settings_json` text,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`object_key` text,\n\t`error` text,\n\t`error_code` text,\n\t`credits` integer DEFAULT 0 NOT NULL,\n\t`attempts` integer DEFAULT 0 NOT NULL,\n\t`heartbeat_at` integer,\n\t`frames_done` integer DEFAULT 0 NOT NULL,\n\t`frames_total` integer DEFAULT 0 NOT NULL,\n\t`cancel_requested` integer DEFAULT false NOT NULL,\n\t`started_at` integer,\n\t`expires_at` integer,\n\t`size_bytes` integer,\n\t`created_by` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\t`completed_at` integer,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `renders_project_created_idx` ON `renders` (`project_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `renders_status_idx` ON `renders` (`status`);",
  "CREATE INDEX IF NOT EXISTS `renders_version_idx` ON `renders` (`version_id`);",
  "CREATE INDEX IF NOT EXISTS `renders_running_heartbeat_idx` ON `renders` (`heartbeat_at`) WHERE \"renders\".\"status\" = 'running';",
  "CREATE INDEX IF NOT EXISTS `renders_completed_expires_idx` ON `renders` (`expires_at`) WHERE \"renders\".\"status\" = 'completed';",
  "CREATE TABLE IF NOT EXISTS `comments` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`project_id` text NOT NULL,\n\t`comp_id` text NOT NULL,\n\t`layer_id` text,\n\t`time_ticks` integer,\n\t`body` text NOT NULL,\n\t`author_id` text,\n\t`resolved_at` integer,\n\t`parent_id` text,\n\t`resolved_by` text,\n\t`guest_name` text,\n\t`guest_email` text,\n\t`share_token_id` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE INDEX IF NOT EXISTS `comments_project_resolved_idx` ON `comments` (`project_id`,`resolved_at`);",
  "CREATE INDEX IF NOT EXISTS `comments_project_created_idx` ON `comments` (`project_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `comments_parent_idx` ON `comments` (`parent_id`);",
  "CREATE TABLE IF NOT EXISTS `audit_log` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`workspace_id` text NOT NULL,\n\t`actor_id` text,\n\t`action` text NOT NULL,\n\t`target_type` text,\n\t`target_id` text,\n\t`metadata` text,\n\t`ip` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null\n);",
  "CREATE INDEX IF NOT EXISTS `audit_log_workspace_created_idx` ON `audit_log` (`workspace_id`,\"created_at\" desc);",
  "CREATE INDEX IF NOT EXISTS `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);",
  "CREATE TABLE IF NOT EXISTS `stripe_customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`organization_id` text NOT NULL,\n\t`stripe_customer_id` text NOT NULL,\n\t`card_fingerprint` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `stripe_customers_organization_uniq` ON `stripe_customers` (`organization_id`);",
  "CREATE INDEX IF NOT EXISTS `stripe_customers_fingerprint_idx` ON `stripe_customers` (`card_fingerprint`);",
  "CREATE TABLE IF NOT EXISTS `subscriptions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`organization_id` text NOT NULL,\n\t`plan_id` text NOT NULL,\n\t`status` text NOT NULL,\n\t`stripe_subscription_id` text,\n\t`current_period_end` integer,\n\t`trial_end` integer,\n\t`cancel_at_period_end` integer DEFAULT false NOT NULL,\n\t`grace_end` integer,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `subscriptions_organization_uniq` ON `subscriptions` (`organization_id`);",
  "CREATE INDEX IF NOT EXISTS `subscriptions_status_idx` ON `subscriptions` (`status`);",
  "CREATE TABLE IF NOT EXISTS `invoices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`organization_id` text NOT NULL,\n\t`stripe_invoice_id` text NOT NULL,\n\t`amount_cents` integer NOT NULL,\n\t`currency` text NOT NULL,\n\t`status` text NOT NULL,\n\t`period_start` integer,\n\t`period_end` integer,\n\t`hosted_url` text,\n\t`pdf_url` text,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `invoices_workspace_stripe_uniq` ON `invoices` (`organization_id`,`stripe_invoice_id`);",
  "CREATE INDEX IF NOT EXISTS `invoices_workspace_created_idx` ON `invoices` (`organization_id`,\"created_at\" desc);",
  "CREATE TABLE IF NOT EXISTS `user_settings` (\n\t`user_id` text PRIMARY KEY NOT NULL,\n\t`auto_apply_enabled` integer DEFAULT false NOT NULL,\n\t`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
  "CREATE TABLE IF NOT EXISTS `webhook_events` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`provider` text NOT NULL,\n\t`event_id` text NOT NULL,\n\t`event_type` text,\n\t`payload_json` text,\n\t`processed_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `webhook_events_provider_event_uniq` ON `webhook_events` (`provider`,`event_id`);",
  "CREATE TABLE IF NOT EXISTS `share_tokens` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`project_id` text NOT NULL,\n\t`token_hash` text NOT NULL,\n\t`password_hash` text,\n\t`expires_at` integer,\n\t`revoked_at` integer,\n\t`created_by` text NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS `share_tokens_token_hash_uniq` ON `share_tokens` (`token_hash`);",
  "CREATE INDEX IF NOT EXISTS `share_tokens_project_idx` ON `share_tokens` (`project_id`,\"created_at\" desc);",
  "CREATE TABLE IF NOT EXISTS `presence_heartbeats` (\n\t`project_id` text NOT NULL,\n\t`user_id` text NOT NULL,\n\t`display_name` text NOT NULL,\n\t`comp_id` text,\n\t`playhead_ticks` integer,\n\t`last_seen_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,\n\tPRIMARY KEY(`project_id`, `user_id`),\n\tFOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);",
];

/**
 * Create every twin table if missing. Idempotent; synchronous (better-sqlite3).
 * Throws on the first malformed statement — a dev database that cannot be
 * bootstrapped must fail loudly, not limp.
 */
export function bootstrapSqliteDatabase(client: Database): void {
  client.exec(BOOTSTRAP_DDL.join("\n"));
}

/** Number of bootstrap statements (test hook + drift tripwire). */
export const SQLITE_BOOTSTRAP_STATEMENTS: number = BOOTSTRAP_DDL.length;
