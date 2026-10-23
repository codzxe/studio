ALTER TABLE "credit_ledger" ADD COLUMN "render_id" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "version_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "frames_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "frames_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_render_idx" ON "credit_ledger" USING btree ("render_id");--> statement-breakpoint
CREATE INDEX "renders_version_idx" ON "renders" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "renders_running_heartbeat_idx" ON "renders" USING btree ("heartbeat_at") WHERE "renders"."status" = 'running';--> statement-breakpoint
CREATE INDEX "renders_completed_expires_idx" ON "renders" USING btree ("expires_at") WHERE "renders"."status" = 'completed';