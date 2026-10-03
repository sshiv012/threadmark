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
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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

export const prdStatus = pgEnum('prd_status', ['active', 'archived']);
export const prdBranchStatus = pgEnum('prd_branch_status', ['active', 'merged', 'abandoned']);

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
// ── PRD persistence (MVP-1a; design: docs/architecture-collab-prd.md §2) ─────
// Cross-parent integrity is enforced by the database with composite foreign
// keys (child carries the parent's scope columns), so a row can never pair a
// branch, block or version with a different PRD/workspace than its parent.

export const prds = pgTable(
  'prds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: prdStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prds_workspace_idx').on(t.workspaceId),
    unique('prds_id_workspace_uniq').on(t.id, t.workspaceId), // composite-FK target
  ],
);

export const prdBranches = pgTable(
  'prd_branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prdId: uuid('prd_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(), // denormalized for workspace-scoped reads
    name: text('name').notNull(),
    // Lineage only (NOT a merge target). Null for the PRD's root branch. NO ACTION
    // on delete: a composite FK cannot SET NULL without nulling prd_id, so a fork
    // source cannot be deleted while a fork exists (deleting the whole PRD is fine).
    forkedFromBranchId: uuid('forked_from_branch_id'),
    status: prdBranchStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'prd_branches_prd_workspace_fk',
      columns: [t.prdId, t.workspaceId],
      foreignColumns: [prds.id, prds.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'prd_branches_fork_source_fk',
      columns: [t.forkedFromBranchId, t.prdId],
      foreignColumns: [t.id, t.prdId],
    }),
    check('prd_branches_no_self_fork', sql`${t.forkedFromBranchId} <> ${t.id}`),
    unique('prd_branches_id_prd_uniq').on(t.id, t.prdId), // composite-FK target
    uniqueIndex('prd_branches_prd_name_uniq').on(t.prdId, t.name),
    // At most one root per PRD. createPrd creates it; the index alone does not
    // guarantee one exists.
    uniqueIndex('prd_branches_root_uniq')
      .on(t.prdId)
      .where(sql`forked_from_branch_id IS NULL`),
    index('prd_branches_workspace_idx').on(t.workspaceId),
  ],
);

// Stable block identity, PRD-scoped (no owning branch). Per-branch presence lives
// in prdBranchBlocks and per-branch content in prdBlockVersions.
export const prdBlocks = pgTable(
  'prd_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prdId: uuid('prd_id')
      .notNull()
      .references(() => prds.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prd_blocks_prd_idx').on(t.prdId),
    unique('prd_blocks_id_prd_uniq').on(t.id, t.prdId), // composite-FK target
  ],
);

export const prdBranchBlocks = pgTable(
  'prd_branch_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prdId: uuid('prd_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    blockId: uuid('block_id').notNull(),
    ord: integer('ord').notNull(), // display position, not identity
    removedAt: timestamp('removed_at', { withTimezone: true }), // soft-delete from THIS branch only
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'prd_branch_blocks_branch_fk',
      columns: [t.branchId, t.prdId],
      foreignColumns: [prdBranches.id, prdBranches.prdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'prd_branch_blocks_block_fk',
      columns: [t.blockId, t.prdId],
      foreignColumns: [prdBlocks.id, prdBlocks.prdId],
    }).onDelete('cascade'),
    check('prd_branch_blocks_ord_nonneg', sql`${t.ord} >= 0`),
    unique('prd_branch_blocks_branch_block_uniq').on(t.branchId, t.blockId), // also the version FK target
    uniqueIndex('prd_branch_blocks_branch_ord_uniq')
      .on(t.branchId, t.ord)
      .where(sql`removed_at IS NULL`),
  ],
);

// Content is branch-scoped. NOTE: `content` is plain text per the design doc; the
// text-vs-structured (Tiptap JSON) decision is revisited before the version-append
// slice, so treat the column type as provisional.
export const prdBlockVersions = pgTable(
  'prd_block_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockId: uuid('block_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    seq: integer('seq').notNull(), // per-(block, branch) version number; allocation lands with append
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    authorKind: text('author_kind').notNull(), // 'human' | 'agent_persona'
    authorSubjectId: text('author_subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A version must hang off an existing branch-block association, not merely an
    // independently valid block and branch.
    foreignKey({
      name: 'prd_block_versions_assoc_fk',
      columns: [t.branchId, t.blockId],
      foreignColumns: [prdBranchBlocks.branchId, prdBranchBlocks.blockId],
    }).onDelete('cascade'),
    check('prd_block_versions_seq_pos', sql`${t.seq} >= 1`),
    check('prd_block_versions_author_kind', sql`${t.authorKind} IN ('human', 'agent_persona')`),
    uniqueIndex('prd_block_versions_seq_uniq').on(t.blockId, t.branchId, t.seq),
  ],
);

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

export type Prd = typeof prds.$inferSelect;
export type PrdBranch = typeof prdBranches.$inferSelect;
export type PrdBlock = typeof prdBlocks.$inferSelect;
export type PrdBranchBlock = typeof prdBranchBlocks.$inferSelect;
export type PrdBlockVersion = typeof prdBlockVersions.$inferSelect;
export type PrdStatus = (typeof prdStatus.enumValues)[number];
export type PrdBranchStatus = (typeof prdBranchStatus.enumValues)[number];
