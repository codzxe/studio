CREATE TABLE "presence_heartbeats" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"comp_id" text,
	"playhead_ticks" bigint,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_heartbeats_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_email" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "share_token_id" text;--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_tokens_token_hash_uniq" ON "share_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_tokens_project_idx" ON "share_tokens" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");