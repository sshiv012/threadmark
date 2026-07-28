CREATE TYPE "public"."eval_report_kind" AS ENUM('retrieval', 'trajectory');--> statement-breakpoint
CREATE TABLE "eval_judgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"doc_id" text NOT NULL,
	"chunk_source_key" text NOT NULL,
	"relevance" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"query_text" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "eval_report_kind" DEFAULT 'retrieval' NOT NULL,
	"config_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"per_query" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_judgments" ADD CONSTRAINT "eval_judgments_query_id_eval_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."eval_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_queries" ADD CONSTRAINT "eval_queries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_reports" ADD CONSTRAINT "eval_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_judgments_query_doc_chunk_uniq" ON "eval_judgments" USING btree ("query_id","doc_id","chunk_source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_queries_workspace_external_id_uniq" ON "eval_queries" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE INDEX "eval_reports_workspace_kind_idx" ON "eval_reports" USING btree ("workspace_id","kind","created_at");