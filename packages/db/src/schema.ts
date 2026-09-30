/**
 * Drizzle schema — first slice of the Threadmark data model (PR3).
 *
 * Postgres is the system of record. These tables back document ingestion;
 * OpenSearch and the pgvector index are derived and rebuildable from here.
 *
 * Later PRs add prd / prd_branch / prd_block / prd_block_version / citation /
 * comment / memory tables. agent_run / agent_step (PR5b-1) and eval_* (PR7)
 * already landed.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
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

// 'pending' = access requested but not yet granted; 'active' = usable for
// login/RBAC. SQL-level default is 'pending' — fail-closed — so a future
// insert path that forgets to set status explicitly never silently grants
// access. The migration backfills every pre-existing row to 'active'
// (created via the old addMembership(), which always meant "already
// granted"); only the new access-request path relies on the pending default.
export const membershipStatus = pgEnum('membership_status', ['pending', 'active']);

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

export const agentRunKind = pgEnum('agent_run_kind', ['ingestion', 'prd_generation', 'qa']);

export const agentRunStatus = pgEnum('agent_run_status', [
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const agentStepStatus = pgEnum('agent_step_status', ['running', 'completed', 'failed']);

// Persisted alongside agent_steps.error so a support engineer querying
// Postgres directly can distinguish "gate/validation denied the tool call"
// (run still completes) from "the tool itself is broken" (run fails) without
// needing trace access. Only set on a failed step.
export const agentStepErrorCode = pgEnum('agent_step_error_code', [
  'authorization_denied',
  'invalid_query',
  'infrastructure_error',
]);

// 'trajectory' is reserved for a future LLM-judge tier over agent traces —
// unused today, mirrors how agent_run_kind reserves 'prd_generation' ahead of
// the PRD-generation workflow existing.
export const evalReportKind = pgEnum('eval_report_kind', ['retrieval', 'trajectory']);

export const conflictResolutionStrategy = pgEnum('conflict_resolution_strategy', [
  'most_recent',
  'highest_priority_source',
  'flag_for_review',
]);

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
    status: membershipStatus('status').notNull().default('pending'),
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
    // Provenance: which embedding model produced `embedding`. A mismatch with
    // the configured model marks the chunk for re-embedding.
    embeddingModel: text('embedding_model'),
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
    // Nullable ONLY for kind='qa': a cited-Q&A run has no natural subject
    // entity the way ingestion (a document) or prd_generation (a prd) do.
    // The check constraint below enforces BOTH directions — required for
    // every other kind (same as before this column became nullable) AND
    // forbidden for 'qa', so a 'qa' row can never carry a stray subjectId.
    subjectId: uuid('subject_id'),
    status: agentRunStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_runs_workspace_idx').on(table.workspaceId),
    check(
      'agent_runs_subject_id_required_unless_qa',
      sql`(${table.kind} = 'qa' AND ${table.subjectId} IS NULL) OR (${table.kind} != 'qa' AND ${table.subjectId} IS NOT NULL)`,
    ),
  ],
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
    // Only set alongside error, on a failed step.
    errorCode: agentStepErrorCode('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('agent_steps_run_idx').on(table.runId)],
);

export const evalQueries = pgTable(
  'eval_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Fixture-stable slug; the idempotency key eval-seed upserts against.
    externalId: text('external_id').notNull(),
    queryText: text('query_text').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_queries_workspace_external_id_uniq').on(table.workspaceId, table.externalId),
  ],
);

export const evalJudgments = pgTable(
  'eval_judgments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryId: uuid('query_id')
      .notNull()
      .references(() => evalQueries.id, { onDelete: 'cascade' }),
    // Durable natural key — NOT chunks.id, which is regenerated on fresh
    // ingest. docId matches evidence_documents.title for the eval corpus;
    // chunkSourceKey matches chunks.source_key (already stable for unchanged
    // content). Resolved to a live chunk at seed time, never persisted here.
    docId: text('doc_id').notNull(),
    chunkSourceKey: text('chunk_source_key').notNull(),
    // 0 (not relevant) .. 3 (primary answer); app-validated, not DB-constrained.
    relevance: integer('relevance').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_judgments_query_doc_chunk_uniq').on(
      table.queryId,
      table.docId,
      table.chunkSourceKey,
    ),
  ],
);

export const evalReports = pgTable(
  'eval_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: evalReportKind('kind').notNull().default('retrieval'),
    // Free text, not enum: 'lexical_only'|'vector_only'|'hybrid_no_rerank'|
    // 'hybrid_rerank' today; a future eval tier's config names need no
    // migration to add.
    configName: text('config_name').notNull(),
    config: jsonb('config').notNull(),
    metrics: jsonb('metrics').notNull(),
    perQuery: jsonb('per_query'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('eval_reports_workspace_kind_idx').on(table.workspaceId, table.kind, table.createdAt),
  ],
);

// At most one policy row per workspace; a workspace with none gets the
// synthesized default ({strategy:'flag_for_review', config:{}}) at read
// time (see getConflictPolicy) — no row is required to exist.
export const conflictResolutionPolicies = pgTable('conflict_resolution_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  strategy: conflictResolutionStrategy('strategy').notNull().default('flag_for_review'),
  // e.g. { sourceTypePriority: ['prior_prd', 'product_doc', ...] } for
  // highest_priority_source; {} for the other two strategies.
  config: jsonb('config').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
export type EvalQuery = typeof evalQueries.$inferSelect;
export type NewEvalQuery = typeof evalQueries.$inferInsert;
export type EvalJudgment = typeof evalJudgments.$inferSelect;
export type NewEvalJudgment = typeof evalJudgments.$inferInsert;
export type EvalReport = typeof evalReports.$inferSelect;
export type NewEvalReport = typeof evalReports.$inferInsert;
export type ConflictResolutionPolicy = typeof conflictResolutionPolicies.$inferSelect;
export type NewConflictResolutionPolicy = typeof conflictResolutionPolicies.$inferInsert;

export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type MembershipStatus = (typeof membershipStatus.enumValues)[number];
export type DocumentStatus = (typeof documentStatus.enumValues)[number];
export type EvidenceSourceType = (typeof evidenceSourceType.enumValues)[number];
export type AgentRunKind = (typeof agentRunKind.enumValues)[number];
export type AgentRunStatus = (typeof agentRunStatus.enumValues)[number];
export type AgentStepStatus = (typeof agentStepStatus.enumValues)[number];
export type AgentStepErrorCode = (typeof agentStepErrorCode.enumValues)[number];
export type EvalReportKind = (typeof evalReportKind.enumValues)[number];
export type ConflictResolutionStrategy = (typeof conflictResolutionStrategy.enumValues)[number];
