/** Shared constants + types across worker, workflows, activities, and client. */
export const INGESTION_TASK_QUEUE = 'ingestion';

/** OpenSearch index holding chunk text for lexical (BM25) retrieval. */
export const CHUNK_INDEX = 'threadmark-chunks';

/**
 * Dedicated, semi-permanent workspace for the retrieval eval harness — seeded
 * once via `pnpm eval:seed`, never edited ad hoc. Distinct from "Dev
 * Workspace" (used by the manual `pnpm ingest`/`pnpm retrieve` CLIs) so eval
 * judgments' chunk resolution stays stable and isn't disturbed by unrelated
 * manual testing against the same corpus.
 */
export const EVAL_WORKSPACE_NAME = 'Eval Corpus — dashboard-sharing';

export interface IngestionWorkflowInput {
  documentId: string;
}

/** Args passed to each pipeline activity for observability threading. */
export interface StepInput {
  documentId: string;
  runId: string;
  ord: number;
}
