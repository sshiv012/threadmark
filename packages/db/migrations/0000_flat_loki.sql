CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('queued', 'extracting', 'chunking', 'embedding', 'indexing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."evidence_source_type" AS ENUM('interview', 'support_ticket', 'product_doc', 'prior_prd', 'github_issue', 'analytics', 'tech_constraint', 'other');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'editor', 'commenter', 'viewer');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" "evidence_source_type" NOT NULL,
	"title" text NOT NULL,
	"blob_uri" text NOT NULL,
	"checksum" text NOT NULL,
	"status" "document_status" DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_evidence_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."evidence_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_ord_uniq" ON "chunks" USING btree ("document_id","ord");--> statement-breakpoint
CREATE INDEX "evidence_documents_workspace_idx" ON "evidence_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_uniq" ON "memberships" USING btree ("workspace_id","user_id");