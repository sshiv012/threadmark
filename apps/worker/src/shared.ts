/** Shared constants + types across worker, workflows, activities, and client. */
export const INGESTION_TASK_QUEUE = 'ingestion';

export interface IngestionWorkflowInput {
  documentId: string;
}
