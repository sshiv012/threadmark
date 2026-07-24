/**
 * Temporal activities — the ONLY place ingestion touches the outside world
 * (DB, blob, models, search). Workflows call these via proxyActivities.
 *
 * PR5b-3a (harness): just the terminal status transition. The real
 * extract→chunk→embed→index activities land in 5b-3b.
 */
import { createDb, updateDocumentStatus } from '@threadmark/db';
import { env } from './env.js';

// Module-level pool: activities run in the long-lived worker process.
const { db } = createDb(env.databaseUrl);

/** Mark a document ready (idempotent — a plain status write). */
export async function markDocumentReady(documentId: string): Promise<void> {
  await updateDocumentStatus(db, documentId, 'ready');
}
