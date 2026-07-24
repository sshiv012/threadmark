/** Shared constants + types across worker, workflows, activities, and client. */
export const INGESTION_TASK_QUEUE = 'ingestion';

/** OpenSearch index holding chunk text for lexical (BM25) retrieval. */
export const CHUNK_INDEX = 'threadmark-chunks';

export interface IngestionWorkflowInput {
  documentId: string;
}

/** Args passed to each pipeline activity for observability threading. */
export interface StepInput {
  documentId: string;
  runId: string;
  ord: number;
}
