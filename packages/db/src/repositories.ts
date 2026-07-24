/**
 * Thin typed repositories over the schema. These are the seams every side
 * effect goes through; business logic lives in services/activities, not here.
 *
 * Kept minimal for PR3 — just what ingestion (PR5) and its tests need.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  agentRuns,
  agentSteps,
  chunks,
  evidenceDocuments,
  memberships,
  users,
  workspaces,
  type AgentRun,
  type AgentRunStatus,
  type AgentStep,
  type AgentStepStatus,
  type Chunk,
  type DocumentStatus,
  type EvidenceDocument,
  type Membership,
  type NewAgentRun,
  type NewAgentStep,
  type NewChunk,
  type NewEvidenceDocument,
  type NewMembership,
  type NewUser,
  type NewWorkspace,
  type User,
  type Workspace,
} from './schema.js';

// ── Workspaces / users / memberships ─────────────────────────────────────────
export async function createWorkspace(db: Database, input: NewWorkspace): Promise<Workspace> {
  const [row] = await db.insert(workspaces).values(input).returning();
  return row!;
}

export async function getWorkspace(db: Database, id: string): Promise<Workspace | undefined> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row;
}

/**
 * Reuse a workspace by name for dev tooling (CLI, seed). NOTE: workspace names
 * are not unique, so this is only idempotent under sequential use — concurrent
 * callers could race and create duplicates. Dev-only; do not rely on it as a
 * strong uniqueness guarantee.
 */
export async function findOrCreateWorkspaceByName(db: Database, name: string): Promise<Workspace> {
  const [existing] = await db.select().from(workspaces).where(eq(workspaces.name, name)).limit(1);
  return existing ?? createWorkspace(db, { name });
}

export async function createUser(db: Database, input: NewUser): Promise<User> {
  const [row] = await db.insert(users).values(input).returning();
  return row!;
}

export async function getUserByEmail(db: Database, email: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
}

export async function addMembership(db: Database, input: NewMembership): Promise<Membership> {
  const [row] = await db.insert(memberships).values(input).returning();
  return row!;
}

export async function listMemberships(db: Database, workspaceId: string): Promise<Membership[]> {
  return db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId));
}

// ── Evidence documents ───────────────────────────────────────────────────────
export async function createEvidenceDocument(
  db: Database,
  input: NewEvidenceDocument,
): Promise<EvidenceDocument> {
  const [row] = await db.insert(evidenceDocuments).values(input).returning();
  return row!;
}

/**
 * Look up a document by its content within a workspace. Lets ingestion be
 * idempotent per source identity: retrying the same file reuses the existing
 * (queued/failed) document instead of creating a duplicate.
 */
export async function findEvidenceDocumentByChecksum(
  db: Database,
  workspaceId: string,
  checksum: string,
): Promise<EvidenceDocument | undefined> {
  const [row] = await db
    .select()
    .from(evidenceDocuments)
    .where(
      and(eq(evidenceDocuments.workspaceId, workspaceId), eq(evidenceDocuments.checksum, checksum)),
    )
    .limit(1);
  return row;
}

export async function getEvidenceDocument(
  db: Database,
  id: string,
): Promise<EvidenceDocument | undefined> {
  const [row] = await db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.id, id))
    .limit(1);
  return row;
}

/** Record an ingestion state transition. Every transition is observable. */
export async function updateDocumentStatus(
  db: Database,
  id: string,
  status: DocumentStatus,
  statusReason: string | null = null,
): Promise<EvidenceDocument | undefined> {
  const [row] = await db
    .update(evidenceDocuments)
    .set({ status, statusReason })
    .where(eq(evidenceDocuments.id, id))
    .returning();
  return row;
}

// ── Chunks ───────────────────────────────────────────────────────────────────
/**
 * Idempotent chunk write. Re-running ingestion upserts on the stable
 * (document_id, source_key) — not the shifting ordinal — so edits elsewhere in
 * a document don't duplicate or churn unrelated chunks. Backs the "retryable
 * operations are idempotent" invariant.
 *
 * Embedding is preserved when the content is unchanged: if the incoming
 * content_hash matches the stored one, the existing vector is kept (so a
 * re-ingest that writes chunk text without recomputing embeddings does NOT
 * clobber a valid vector — the "unchanged hash ⇒ skip re-embed" guarantee).
 * When the content changed, the incoming embedding wins (a new vector, or NULL
 * to clear the now-stale one for a later embed pass).
 */
export async function upsertChunks(db: Database, rows: NewChunk[]): Promise<Chunk[]> {
  if (rows.length === 0) return [];
  return db
    .insert(chunks)
    .values(rows)
    .onConflictDoUpdate({
      target: [chunks.documentId, chunks.sourceKey],
      set: {
        ord: sql`excluded.ord`,
        text: sql`excluded.text`,
        contentHash: sql`excluded.content_hash`,
        tokenCount: sql`excluded.token_count`,
        embedding: sql`CASE WHEN ${chunks.contentHash} = excluded.content_hash THEN ${chunks.embedding} ELSE excluded.embedding END`,
      },
    })
    .returning();
}

// ── Agent runs / steps (observability) ───────────────────────────────────────
export async function createAgentRun(db: Database, input: NewAgentRun): Promise<AgentRun> {
  const [row] = await db.insert(agentRuns).values(input).returning();
  return row!;
}

export async function getAgentRun(db: Database, id: string): Promise<AgentRun | undefined> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return row;
}

export async function updateAgentRunStatus(
  db: Database,
  id: string,
  status: AgentRunStatus,
  endedAt?: Date,
): Promise<AgentRun | undefined> {
  const patch: { status: AgentRunStatus; endedAt?: Date } = { status };
  if (endedAt !== undefined) patch.endedAt = endedAt;
  const [row] = await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id)).returning();
  return row;
}

/** Append a step (each retry attempt is its own row, so retries stay visible). */
export async function appendAgentStep(db: Database, input: NewAgentStep): Promise<AgentStep> {
  const [row] = await db.insert(agentSteps).values(input).returning();
  return row!;
}

export interface AgentStepPatch {
  status?: AgentStepStatus;
  outputSummary?: string | null;
  error?: string | null;
  endedAt?: Date;
}

export async function updateAgentStep(
  db: Database,
  id: string,
  patch: AgentStepPatch,
): Promise<AgentStep | undefined> {
  const [row] = await db.update(agentSteps).set(patch).where(eq(agentSteps.id, id)).returning();
  return row;
}

export async function listAgentSteps(db: Database, runId: string): Promise<AgentStep[]> {
  return db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.ord);
}

export async function getChunksByDocument(db: Database, documentId: string): Promise<Chunk[]> {
  return db.select().from(chunks).where(eq(chunks.documentId, documentId)).orderBy(chunks.ord);
}
