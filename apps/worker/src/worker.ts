/**
 * Temporal worker entry point. Bundles the deterministic workflows and
 * registers the side-effecting activities, then polls the ingestion task queue.
 *
 * Run (after build): `node --env-file=.env apps/worker/dist/worker.js`
 */
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { initTelemetry } from '@threadmark/telemetry';
import * as activities from './activities.js';
import { env } from './env.js';
import { INGESTION_TASK_QUEUE } from './shared.js';

async function main(): Promise<void> {
  const shutdownTelemetry = initTelemetry('threadmark-worker');
  const connection = await NativeConnection.connect({ address: env.temporalAddress });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: INGESTION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
      activities,
    });
    console.log(`worker listening on task queue "${INGESTION_TASK_QUEUE}"`);
    await worker.run();
  } finally {
    await connection.close();
    await shutdownTelemetry();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
