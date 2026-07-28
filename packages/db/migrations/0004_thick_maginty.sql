CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active');--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status" "membership_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Every membership row that existed before this migration was created via
-- the old addMembership() path, which always meant "already granted" --
-- backfill them to 'active' explicitly. Only rows created by the NEW
-- access-request flow (after this migration) should ever start 'pending'.
UPDATE "memberships" SET "status" = 'active';