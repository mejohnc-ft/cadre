CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"schedule" text,
	"prompt" text NOT NULL,
	"token_hash" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"thread_mode" text DEFAULT 'continue' NOT NULL,
	"thread_id" text,
	"last_fired_at" timestamp with time zone,
	"last_status" text,
	"last_reply" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;