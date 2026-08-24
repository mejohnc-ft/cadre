ALTER TABLE "connections" ADD COLUMN "session_encrypted" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "session_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "session_expires_hint" text;