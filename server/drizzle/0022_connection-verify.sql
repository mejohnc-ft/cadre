ALTER TABLE "connections" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_verify_status" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_verify_note" text;