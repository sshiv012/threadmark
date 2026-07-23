/**
 * Drizzle schema — first slice of the Threadmark data model (PR3).
 *
 * Postgres is the system of record. These tables back document ingestion;
 * OpenSearch and the pgvector index are derived and rebuildable from here.
 *
 * Later PRs add prd / prd_branch / prd_block / prd_block_version / citation /
 * comment / agent_run / agent_step / eval_* / memory tables.
 */
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Embedding dimensionality is fixed at the schema level because pgvector
 * columns (and their indexes) require a fixed size. 384 matches the default
 * embedding model, bge-small-en-v1.5. Switching to a model with a different
 * dimensionality requires a migration.
 */
export const EMBEDDING_DIMENSIONS = 384;

// ── Enums ────────────────────────────────────────────────────────────────────
export const membershipRole = pgEnum('membership_role', ['owner', 'editor', 'commenter', 'viewer']);

export const documentStatus = pgEnum('document_status', [
  'queued',
  'extracting',
  'chunking',
  'embedding',
  'indexing',
  'ready',
  'failed',
]);

export const evidenceSourceType = pgEnum('evidence_source_type', [
  'interview',
  'support_ticket',
  'product_doc',
  'prior_prd',
  'github_issue',
  'analytics',
  'tech_constraint',
  'other',
]);

export const agentRunKind = pgEnum('agent_run_kind', ['ingestion', 'prd_generation']);

export const agentRunStatus = pgEnum('agent_run_status', [
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const agentStepStatus = pgEnum('agent_step_status', ['running', 'completed', 'failed']);

// ── Tables ───────────────────────────────────────────────────────────────────
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('memberships_workspace_user_uniq').on(table.workspaceId, table.userId)],
);

export const evidenceDocuments = pgTable(
  'evidence_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: evidenceSourceType('source_type').notNull(),
    title: text('title').notNull(),
    // Points at the raw uploaded file in the blob store (MinIO/S3).
    blobUri: text('blob_uri').notNull(),
    // Content hash of the source bytes — enables idempotent re-ingestion.
    checksum: text('checksum').notNull(),
    status: documentStatus('status').notNull().default('queued'),
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evidence_documents_workspace_idx').on(table.workspaceId)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => evidenceDocuments.id, { onDelete: 'cascade' }),
    // Ordering / display position only — NOT identity (shifts under edits).
    ord: integer('ord').notNull(),
    // Stable identity within the document (heading path, message id, row key, …).
    sourceKey: text('source_key').notNull(),
    // Hash of normalized chunk text; unchanged hash on re-ingest ⇒ skip re-embed.
    contentHash: text('content_hash').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    // Nullable: chunk text may be persisted before embeddings are computed.
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Idempotency key: stable source identity, not the shifting ordinal.
  (table) => [uniqueIndex('chunks_document_source_key_uniq').on(table.documentId, table.sourceKey)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: agentRunKind('kind').notNull(),
    // The entity this run acts on (e.g. an evidence_document or prd id).
    subjectId: uuid('subject_id').notNull(),
    status: agentRunStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('agent_runs_workspace_idx').on(table.workspaceId)],
);

export const agentSteps = pgTable(
  'agent_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // Ordering within the run. Each retry attempt is its own row, so failures
    // and retries stay visible rather than being overwritten.
    ord: integer('ord').notNull(),
    type: text('type').notNull(),
    status: agentStepStatus('status').notNull().default('running'),
    attempt: integer('attempt').notNull().default(1),
    inputSummary: text('input_summary'),
    outputSummary: text('output_summary'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('agent_steps_run_idx').on(table.runId)],
);

// ── Inferred types ───────────────────────────────────────────────────────────
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type EvidenceDocument = typeof evidenceDocuments.$inferSelect;
export type NewEvidenceDocument = typeof evidenceDocuments.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentStep = typeof agentSteps.$inferSelect;
export type NewAgentStep = typeof agentSteps.$inferInsert;

export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type DocumentStatus = (typeof documentStatus.enumValues)[number];
export type EvidenceSourceType = (typeof evidenceSourceType.enumValues)[number];
export type AgentRunKind = (typeof agentRunKind.enumValues)[number];
export type AgentRunStatus = (typeof agentRunStatus.enumValues)[number];
export type AgentStepStatus = (typeof agentStepStatus.enumValues)[number];
