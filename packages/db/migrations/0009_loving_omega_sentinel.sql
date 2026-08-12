CREATE TYPE "public"."conflict_resolution_strategy" AS ENUM('most_recent', 'highest_priority_source', 'flag_for_review');--> statement-breakpoint
CREATE TABLE "conflict_resolution_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"strategy" "conflict_resolution_strategy" DEFAULT 'flag_for_review' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_resolution_policies_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "conflict_resolution_policies" ADD CONSTRAINT "conflict_resolution_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;