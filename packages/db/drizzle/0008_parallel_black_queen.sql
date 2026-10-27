ALTER TABLE "agent_runs" ADD COLUMN "last_step_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
CREATE INDEX "agent_runs_status_heartbeat_idx" ON "agent_runs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "agent_steps_tool_call_idx" ON "agent_steps" USING btree ("tool_call_id");