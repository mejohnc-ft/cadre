CREATE TABLE "node_enrollment_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_node" text,
	CONSTRAINT "node_enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"supervisor_url" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"backend" text NOT NULL,
	"placement_enabled" boolean DEFAULT true NOT NULL,
	"enrolled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_health" jsonb
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moved_from" text
);
--> statement-breakpoint
ALTER TABLE "node_enrollment_tokens" ADD CONSTRAINT "node_enrollment_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placements_node_idx" ON "placements" USING btree ("node_id");