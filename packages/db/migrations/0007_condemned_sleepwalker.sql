CREATE TYPE "public"."agent_step_error_code" AS ENUM('authorization_denied', 'invalid_query', 'infrastructure_error');--> statement-breakpoint
ALTER TYPE "public"."agent_run_kind" ADD VALUE 'qa';--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "subject_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "error_code" "agent_step_error_code";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_subject_id_required_unless_qa" CHECK ("agent_runs"."kind" = 'qa' OR "agent_runs"."subject_id" IS NOT NULL);