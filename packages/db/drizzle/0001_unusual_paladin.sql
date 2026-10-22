ALTER TABLE "agent_runs" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "applied_batch_sha256" char(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "applied_version_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "undone_by" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_base_version_id_project_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_applied_version_id_project_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_undone_by_user_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;