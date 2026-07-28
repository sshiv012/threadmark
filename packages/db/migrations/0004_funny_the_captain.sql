CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active');--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status" "membership_status" DEFAULT 'active' NOT NULL;