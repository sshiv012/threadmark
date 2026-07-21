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
    // Position within the document; unique per document for idempotent upserts.
    ord: integer('ord').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    // Nullable: chunk text may be persisted before embeddings are computed.
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('chunks_document_ord_uniq').on(table.documentId, table.ord)],
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

export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type DocumentStatus = (typeof documentStatus.enumValues)[number];
export type EvidenceSourceType = (typeof evidenceSourceType.enumValues)[number];
