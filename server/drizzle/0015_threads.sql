-- Memory recall needs pgvector. Upstream dropped the extension with its document index (0010);
-- agent memory brings it back for a different purpose.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_runs" (
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"agent_id" text NOT NULL,
	"parent_run_id" text,
	"events" jsonb NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_runs_thread_id_run_id_pk" PRIMARY KEY("thread_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_runs" ADD CONSTRAINT "thread_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_scope_idx" ON "agent_memories" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE INDEX "thread_runs_sequence_idx" ON "thread_runs" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "threads_user_updated_idx" ON "threads" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_memories_embedding_idx" ON "agent_memories" USING hnsw ("embedding" vector_cosine_ops);
