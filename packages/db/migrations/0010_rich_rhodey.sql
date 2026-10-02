CREATE TYPE "public"."prd_branch_status" AS ENUM('active', 'merged', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."prd_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "prd_block_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prd_block_versions_seq_pos" CHECK ("prd_block_versions"."seq" >= 1),
	CONSTRAINT "prd_block_versions_author_kind" CHECK ("prd_block_versions"."author_kind" IN ('human', 'agent_persona'))
);
--> statement-breakpoint
CREATE TABLE "prd_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prd_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prd_blocks_id_prd_uniq" UNIQUE("id","prd_id")
);
--> statement-breakpoint
CREATE TABLE "prd_branch_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prd_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prd_branch_blocks_branch_block_uniq" UNIQUE("branch_id","block_id"),
	CONSTRAINT "prd_branch_blocks_ord_nonneg" CHECK ("prd_branch_blocks"."ord" >= 0)
);
--> statement-breakpoint
CREATE TABLE "prd_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prd_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"forked_from_branch_id" uuid,
	"status" "prd_branch_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prd_branches_id_prd_uniq" UNIQUE("id","prd_id"),
	CONSTRAINT "prd_branches_no_self_fork" CHECK ("prd_branches"."forked_from_branch_id" <> "prd_branches"."id")
);
--> statement-breakpoint
CREATE TABLE "prds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "prd_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prds_id_workspace_uniq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "prd_block_versions" ADD CONSTRAINT "prd_block_versions_assoc_fk" FOREIGN KEY ("branch_id","block_id") REFERENCES "public"."prd_branch_blocks"("branch_id","block_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_blocks" ADD CONSTRAINT "prd_blocks_prd_id_prds_id_fk" FOREIGN KEY ("prd_id") REFERENCES "public"."prds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_branch_blocks" ADD CONSTRAINT "prd_branch_blocks_branch_fk" FOREIGN KEY ("branch_id","prd_id") REFERENCES "public"."prd_branches"("id","prd_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_branch_blocks" ADD CONSTRAINT "prd_branch_blocks_block_fk" FOREIGN KEY ("block_id","prd_id") REFERENCES "public"."prd_blocks"("id","prd_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_branches" ADD CONSTRAINT "prd_branches_prd_workspace_fk" FOREIGN KEY ("prd_id","workspace_id") REFERENCES "public"."prds"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prd_branches" ADD CONSTRAINT "prd_branches_fork_source_fk" FOREIGN KEY ("forked_from_branch_id","prd_id") REFERENCES "public"."prd_branches"("id","prd_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prds" ADD CONSTRAINT "prds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prd_block_versions_seq_uniq" ON "prd_block_versions" USING btree ("block_id","branch_id","seq");--> statement-breakpoint
CREATE INDEX "prd_blocks_prd_idx" ON "prd_blocks" USING btree ("prd_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prd_branch_blocks_branch_ord_uniq" ON "prd_branch_blocks" USING btree ("branch_id","ord") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prd_branches_prd_name_uniq" ON "prd_branches" USING btree ("prd_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "prd_branches_root_uniq" ON "prd_branches" USING btree ("prd_id") WHERE forked_from_branch_id IS NULL;--> statement-breakpoint
CREATE INDEX "prd_branches_workspace_idx" ON "prd_branches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "prds_workspace_idx" ON "prds" USING btree ("workspace_id");