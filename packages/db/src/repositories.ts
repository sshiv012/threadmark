/**
 * Thin typed repositories over the schema. These are the seams every side
 * effect goes through; business logic lives in services/activities, not here.
 *
 * Kept minimal for PR3 — just what ingestion (PR5) and its tests need.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  chunks,
  evidenceDocuments,
  memberships,
  users,
  workspaces,
  type Chunk,
  type DocumentStatus,
  type EvidenceDocument,
  type Membership,
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
 * Idempotent chunk write. Re-running ingestion for the same document upserts
 * on (document_id, ord) instead of creating duplicates — the schema-level
 * guarantee behind the "retryable operations are idempotent" invariant.
 */
export async function upsertChunks(db: Database, rows: NewChunk[]): Promise<Chunk[]> {
  if (rows.length === 0) return [];
  return db
    .insert(chunks)
    .values(rows)
    .onConflictDoUpdate({
      target: [chunks.documentId, chunks.ord],
      set: {
        text: sql`excluded.text`,
        tokenCount: sql`excluded.token_count`,
        embedding: sql`excluded.embedding`,
      },
    })
    .returning();
}

export async function getChunksByDocument(db: Database, documentId: string): Promise<Chunk[]> {
  return db.select().from(chunks).where(eq(chunks.documentId, documentId)).orderBy(chunks.ord);
}
