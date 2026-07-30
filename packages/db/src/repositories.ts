/**
 * Thin typed repositories over the schema. These are the seams every side
 * effect goes through; business logic lives in services/activities, not here.
 *
 * Kept minimal for PR3 — just what ingestion (PR5) and its tests need.
 */
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  agentRuns,
  agentSteps,
  chunks,
  evalJudgments,
  evalQueries,
  evalReports,
  evidenceDocuments,
  memberships,
  users,
  workspaces,
  type AgentRun,
  type AgentRunStatus,
  type AgentStep,
  type AgentStepErrorCode,
  type AgentStepStatus,
  type Chunk,
  type DocumentStatus,
  type EvalJudgment,
  type EvalQuery,
  type EvalReport,
  type EvidenceDocument,
  type EvidenceSourceType,
  type Membership,
  type MembershipRole,
  type NewAgentRun,
  type NewAgentStep,
  type NewChunk,
  type NewEvalJudgment,
  type NewEvalQuery,
  type NewEvalReport,
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
 * Read-only lookup by name — distinct from `findOrCreateWorkspaceByName`:
 * callers that need to distinguish "not seeded yet" from "auto-create it"
 * (e.g. the eval harness, which should error with a clear "run eval:seed
 * first" message rather than silently creating an empty workspace) use this.
 * Same non-uniqueness caveat: workspace names aren't unique, so with
 * duplicates this returns *a* match, not a specific one.
 */
export async function findWorkspaceByName(
  db: Database,
  name: string,
): Promise<Workspace | undefined> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.name, name)).limit(1);
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
  const [row] = await db
    .insert(users)
    .values({ ...input, email: normalizeEmail(input.email) })
    .returning();
  return row!;
}

// Emails are case-normalized to lowercase before EVERY lookup/insert —
// createUser included, not just findOrCreateUserByEmail — so
// 'User@Example.com' and 'user@example.com' always resolve to the same
// account. The local part of an email is technically case-sensitive per
// RFC 5321, but universally treated as case-insensitive in practice, and a
// caller across access-requests/login/grants must never be able to create
// two accounts for what a human considers the same address. Normalizing at
// every write path (rather than only the lookup path) is what makes the
// unique constraint on `email` actually enforce that — see also the
// supplementary UNIQUE index on LOWER(email) in migration 0006, which
// catches any future write path that bypasses this function entirely.
function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

export async function getUserByEmail(db: Database, email: string): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row;
}

export async function addMembership(db: Database, input: NewMembership): Promise<Membership> {
  const [row] = await db.insert(memberships).values(input).returning();
  return row!;
}

export async function listMemberships(db: Database, workspaceId: string): Promise<Membership[]> {
  return db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId));
}

/**
 * Find-or-create a user by email — the entry point for the access-request
 * flow. Race-safe via `onConflictDoNothing` (not select-then-insert): under
 * concurrent calls for the same brand-new email, exactly one insert wins and
 * every caller ends up with the same row. `name` is only applied if a new row
 * is created; an existing user's name is left untouched.
 */
export async function findOrCreateUserByEmail(
  db: Database,
  input: { email: string; name: string },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const [inserted] = await db
    .insert(users)
    .values({ email, name: input.name })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted) return inserted;
  const existing = await getUserByEmail(db, email);
  if (!existing) throw new Error('user insert conflicted but no existing row found');
  return existing;
}

/**
 * Find-or-create a PENDING, least-privileged membership for
 * (workspaceId, userId). Race-safe via `onConflictDoNothing` against
 * `memberships_workspace_user_uniq`. Calling this again for an
 * already-pending OR already-active row is a no-op that returns the existing
 * row UNCHANGED — this must never regress an active membership back to
 * pending, or its role back to 'viewer'.
 */
export async function findOrCreatePendingMembership(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<Membership> {
  const [inserted] = await db
    .insert(memberships)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: 'viewer',
      status: 'pending',
    })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] })
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)),
    )
    .limit(1);
  if (!existing) throw new Error('membership insert conflicted but no existing row found');
  return existing;
}

/**
 * Does this user have ANY active membership, in any workspace? The login
 * gate — deliberately cross-workspace, since login itself has no workspace
 * context yet.
 */
export async function hasAnyActiveMembership(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .limit(1);
  return row !== undefined;
}

/**
 * Single-row lookup for (workspaceId, userId) — the request-scoped auth seam:
 * "does this user have ANY relationship (pending or active) with THIS
 * workspace". Applies no status filter itself; callers (the auth
 * preHandler) check `.status === 'active'` themselves. Throws on a
 * syntactically invalid UUID (no shape validation at this layer) — callers
 * that accept a workspaceId/userId from an untrusted source (e.g. an HTTP
 * path param) must validate its shape themselves before calling this.
 */
export async function getMembership(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<Membership | undefined> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)),
    )
    .limit(1);
  return row;
}

/**
 * Thrown by `activateMembership` when the requested change would leave a
 * workspace with zero active owners — only an active owner can grant, so
 * that state is unrecoverable without direct DB access. Callers should map
 * this to a 409, not a 500.
 */
export class LastOwnerDemotionError extends Error {}

/**
 * Activate an existing (workspaceId, userId) membership — the "grant" step.
 * `role` is optional: omitted keeps the existing stored role (e.g. the
 * 'viewer' seeded at request time) unchanged; given, it overwrites it.
 * Returns `undefined` if no membership row exists for this pair — this
 * function only activates a prior request, it never creates one.
 *
 * Runs in a transaction: when `role` would change an existing active owner
 * away from 'owner', the workspace's active-owner rows are locked
 * (`SELECT ... FOR UPDATE`) before deciding whether any would remain —
 * otherwise two concurrent grant requests could each read "there's another
 * owner" before either commits, and both demote, leaving zero. The lock
 * only applies to this narrow case (a plain role-preserving or role='owner'
 * activation never touches it), so it adds no contention to the common path.
 */
export async function activateMembership(
  db: Database,
  input: { workspaceId: string; userId: string; role?: MembershipRole },
): Promise<Membership | undefined> {
  return db.transaction(async (tx) => {
    const possibleDemotion = input.role !== undefined && input.role !== 'owner';
    if (possibleDemotion) {
      const activeOwners = await tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, input.workspaceId),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update');

      const isCurrentlyActiveOwner = activeOwners.some((m) => m.userId === input.userId);
      const remainingOwners = activeOwners.filter((m) => m.userId !== input.userId);
      if (isCurrentlyActiveOwner && remainingOwners.length === 0) {
        throw new LastOwnerDemotionError('cannot remove the last active owner');
      }
    }

    const [row] = await tx
      .update(memberships)
      .set({ status: 'active', ...(input.role ? { role: input.role } : {}) })
      .where(
        and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)),
      )
      .returning();
    return row;
  });
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

/**
 * Look up a document by (workspace, title) — the eval harness resolves a
 * manifest doc_id to its evidence_document this way (the eval-seed ingestion
 * path sets title = docId, unlike the regular ingest CLI). Title isn't
 * unique, so with duplicates this returns *a* match, not a specific one.
 */
export async function findEvidenceDocumentByTitle(
  db: Database,
  workspaceId: string,
  title: string,
): Promise<EvidenceDocument | undefined> {
  const [row] = await db
    .select()
    .from(evidenceDocuments)
    .where(and(eq(evidenceDocuments.workspaceId, workspaceId), eq(evidenceDocuments.title, title)))
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

export async function listAgentRuns(db: Database, workspaceId: string): Promise<AgentRun[]> {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId))
    .orderBy(agentRuns.startedAt);
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
  errorCode?: AgentStepErrorCode | null;
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

/**
 * Set a chunk's embedding + the model that produced it (embed phase). Distinct
 * from `upsertChunks`, whose content-preserving CASE would keep the old vector.
 */
export async function setChunkEmbedding(
  db: Database,
  chunkId: string,
  embedding: number[],
  model: string,
): Promise<void> {
  await db.update(chunks).set({ embedding, embeddingModel: model }).where(eq(chunks.id, chunkId));
}

/**
 * Delete chunks of a document whose source_key is NOT in the current candidate
 * set — i.e. sections removed since the last ingest. Keeps Postgres reconciled
 * with the source on re-ingestion.
 */
export async function deleteChunksNotIn(
  db: Database,
  documentId: string,
  keepSourceKeys: string[],
): Promise<void> {
  const condition =
    keepSourceKeys.length === 0
      ? eq(chunks.documentId, documentId)
      : and(eq(chunks.documentId, documentId), notInArray(chunks.sourceKey, keepSourceKeys));
  await db.delete(chunks).where(condition);
}

export interface VectorHit {
  chunkId: string;
  documentId: string;
  distance: number;
}

/**
 * Exact pgvector kNN over a workspace's embedded chunks (cosine distance).
 * Exact scan — no ANN index yet; establish a recall baseline first. Only
 * `ready` documents are candidates — a failed or currently re-indexing
 * document must not surface in results.
 */
export async function searchChunksByVector(
  db: Database,
  workspaceId: string,
  embedding: number[],
  limit: number,
): Promise<VectorHit[]> {
  const literal = `[${embedding.join(',')}]`;
  const distance = sql<number>`${chunks.embedding} <=> ${literal}::vector`;
  return db
    .select({ chunkId: chunks.id, documentId: chunks.documentId, distance })
    .from(chunks)
    .innerJoin(evidenceDocuments, eq(chunks.documentId, evidenceDocuments.id))
    .where(
      and(
        eq(evidenceDocuments.workspaceId, workspaceId),
        eq(evidenceDocuments.status, 'ready'),
        isNotNull(chunks.embedding),
      ),
    )
    .orderBy(distance)
    .limit(limit);
}

export interface RetrievalChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceType: EvidenceSourceType;
  text: string;
}

/**
 * Load chunk text + owning-document metadata for a set of chunk ids.
 * `workspaceId` is REQUIRED and enforced here as defense in depth: even if a
 * candidate id leaked in from another workspace (e.g. a lexical index bug),
 * hydration will silently drop it rather than return foreign content. Also
 * only hydrates `ready` documents, so a stale/failed doc's chunk never reaches
 * the caller even if it's still indexed in a derived store.
 */
export async function getRetrievalChunksByIds(
  db: Database,
  ids: string[],
  workspaceId: string,
): Promise<RetrievalChunk[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: evidenceDocuments.title,
      sourceType: evidenceDocuments.sourceType,
      text: chunks.text,
    })
    .from(chunks)
    .innerJoin(evidenceDocuments, eq(chunks.documentId, evidenceDocuments.id))
    .where(
      and(
        inArray(chunks.id, ids),
        eq(evidenceDocuments.workspaceId, workspaceId),
        eq(evidenceDocuments.status, 'ready'),
      ),
    );
}

/**
 * A signal that changes whenever a workspace's ready, searchable corpus
 * changes in any way that would make a cached retrieval result stale: a
 * document becomes ready/un-ready, a chunk is added or removed, OR a chunk's
 * content changes (even if the document/chunk COUNTS end up identical — e.g.
 * a re-ingest that edits one chunk's text without adding/removing chunks,
 * which a pure count would miss). Combines a count with a content_hash
 * aggregate, no schema migration required.
 *
 * Not a perfect fingerprint of embedding vectors themselves (two different
 * content_hash-identical embeddings under different models are still
 * distinguished separately via the embedding-model cache-key component), but
 * covers ingestion changes cheaply with two indexed queries.
 */
export async function getWorkspaceRetrievalRevision(
  db: Database,
  workspaceId: string,
): Promise<string> {
  const [docRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(evidenceDocuments)
    .where(
      and(eq(evidenceDocuments.workspaceId, workspaceId), eq(evidenceDocuments.status, 'ready')),
    );
  const [chunkRow] = await db
    .select({
      count: sql<number>`count(*)`,
      contentFingerprint: sql<string>`md5(coalesce(string_agg(${chunks.contentHash}, ',' order by ${chunks.id}), ''))`,
    })
    .from(chunks)
    .innerJoin(evidenceDocuments, eq(chunks.documentId, evidenceDocuments.id))
    .where(
      and(
        eq(evidenceDocuments.workspaceId, workspaceId),
        eq(evidenceDocuments.status, 'ready'),
        isNotNull(chunks.embedding),
      ),
    );
  return `${docRow?.count ?? 0}:${chunkRow?.count ?? 0}:${chunkRow?.contentFingerprint ?? ''}`;
}

// ── Eval harness ─────────────────────────────────────────────────────────────
/**
 * Upsert on (workspaceId, externalId) — re-running eval:seed after editing a
 * fixture's query text/notes updates the row in place rather than silently
 * keeping the stale value, matching `upsertChunks`'s existing convention.
 */
export async function createEvalQuery(db: Database, input: NewEvalQuery): Promise<EvalQuery> {
  const [row] = await db
    .insert(evalQueries)
    .values(input)
    .onConflictDoUpdate({
      target: [evalQueries.workspaceId, evalQueries.externalId],
      set: {
        queryText: sql`excluded.query_text`,
        notes: sql`excluded.notes`,
      },
    })
    .returning();
  return row!;
}

/**
 * Upsert on (queryId, docId, chunkSourceKey) — same update-in-place
 * convention as `createEvalQuery`: a re-graded judgment overwrites the old
 * relevance value rather than being ignored.
 */
export async function upsertEvalJudgment(
  db: Database,
  input: NewEvalJudgment,
): Promise<EvalJudgment> {
  const [row] = await db
    .insert(evalJudgments)
    .values(input)
    .onConflictDoUpdate({
      target: [evalJudgments.queryId, evalJudgments.docId, evalJudgments.chunkSourceKey],
      set: {
        relevance: sql`excluded.relevance`,
      },
    })
    .returning();
  return row!;
}

export async function createEvalReport(db: Database, input: NewEvalReport): Promise<EvalReport> {
  const [row] = await db.insert(evalReports).values(input).returning();
  return row!;
}

export interface EvalQueryWithJudgments {
  query: EvalQuery;
  judgments: EvalJudgment[];
}

/** Every eval_query in a workspace, joined with its judgments (possibly empty). */
export async function listEvalQueriesWithJudgments(
  db: Database,
  workspaceId: string,
): Promise<EvalQueryWithJudgments[]> {
  const queries = await db
    .select()
    .from(evalQueries)
    .where(eq(evalQueries.workspaceId, workspaceId));
  if (queries.length === 0) return [];

  const judgmentRows = await db
    .select()
    .from(evalJudgments)
    .where(
      inArray(
        evalJudgments.queryId,
        queries.map((q) => q.id),
      ),
    );
  const byQueryId = new Map<string, EvalJudgment[]>();
  for (const j of judgmentRows) {
    const list = byQueryId.get(j.queryId) ?? [];
    list.push(j);
    byQueryId.set(j.queryId, list);
  }
  return queries.map((query) => ({ query, judgments: byQueryId.get(query.id) ?? [] }));
}
