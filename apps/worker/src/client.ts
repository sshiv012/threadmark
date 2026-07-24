/** Temporal client helper: start the ingestion workflow and await its result. */
import { Client, Connection } from '@temporalio/client';
import { env } from './env.js';
import { INGESTION_TASK_QUEUE, type IngestionWorkflowInput } from './shared.js';

export async function runIngestionWorkflow(input: IngestionWorkflowInput): Promise<string> {
  const connection = await Connection.connect({ address: env.temporalAddress });
  try {
    const client = new Client({ connection });
    const handle = await client.workflow.start('ingestionWorkflow', {
      taskQueue: INGESTION_TASK_QUEUE,
      workflowId: `ingest-${input.documentId}`,
      args: [input],
    });
    await handle.result();
    return handle.workflowId;
  } finally {
    await connection.close();
  }
}
