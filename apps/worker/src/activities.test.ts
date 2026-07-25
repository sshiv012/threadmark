import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Context } from '@temporalio/activity';
import { createAgentRun, createWorkspace, listAgentSteps, type Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStep } from './activities.js';

vi.mock('@temporalio/activity', () => ({
  Context: { current: vi.fn() },
}));

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

function mockAttempt(attempt: number): void {
  vi.mocked(Context.current).mockReturnValue({ info: { attempt } } as unknown as Context);
}

let db: Database;
let workspaceId: string;
let runId: string;
let exporter: InMemorySpanExporter;

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;

  const workspace = await createWorkspace(db, { name: `activities-test-${Math.random()}` });
  workspaceId = workspace.id;
  const run = await createAgentRun(db, {
    workspaceId,
    kind: 'ingestion',
    subjectId: '00000000-0000-4000-8000-000000000000',
  });
  runId = run.id;

  exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();

  mockAttempt(1);
});

afterEach(() => {
  trace.disable();
  exporter.reset();
  vi.clearAllMocks();
});

describe('withStep', () => {
  it('happy path: DB row completed, span OK, attributes reflect the real call', async () => {
    mockAttempt(1);
    const count = await withStep(
      db,
      { documentId: 'doc-1', runId, ord: 0 },
      'extractAndChunk',
      () => Promise.resolve(3),
    );
    expect(count).toBe(3);

    const steps = await listAgentSteps(db, runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('completed');
    expect(steps[0]!.outputSummary).toBe('3');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('agent_step.extractAndChunk');
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(spans[0]!.attributes['agent_step.run_id']).toBe(runId);
    expect(spans[0]!.attributes['agent_step.step_id']).toBe(steps[0]!.id);
    expect(spans[0]!.attributes['agent_step.ord']).toBe(0);
    expect(spans[0]!.attributes['agent_step.attempt']).toBe(1);
  });

  it('failure path: DB row failed, span ERROR, original error rethrown unchanged', async () => {
    const original = new Error('boom');
    await expect(
      withStep(db, { documentId: 'doc-1', runId, ord: 0 }, 'embedChunks', () =>
        Promise.reject(original),
      ),
    ).rejects.toBe(original);

    const steps = await listAgentSteps(db, runId);
    expect(steps[0]!.status).toBe('failed');
    expect(steps[0]!.error).toBe('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('attempt attribute reflects the real Temporal attempt, not a hardcoded 1', async () => {
    mockAttempt(3);
    await withStep(db, { documentId: 'doc-1', runId, ord: 0 }, 'indexChunks', () =>
      Promise.resolve(1),
    );

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['agent_step.attempt']).toBe(3);

    const steps = await listAgentSteps(db, runId);
    expect(steps[0]!.attempt).toBe(3);
  });

  it('retry-then-succeed produces two independent, correctly-statused spans (never a stale flip)', async () => {
    mockAttempt(1);
    await expect(
      withStep(db, { documentId: 'doc-1', runId, ord: 0 }, 'extractAndChunk', () =>
        Promise.reject(new Error('first attempt fails')),
      ),
    ).rejects.toThrow('first attempt fails');

    mockAttempt(2);
    await withStep(db, { documentId: 'doc-1', runId, ord: 0 }, 'extractAndChunk', () =>
      Promise.resolve(5),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0]!.attributes['agent_step.attempt']).toBe(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[1]!.attributes['agent_step.attempt']).toBe(2);
    expect(spans[1]!.status.code).toBe(SpanStatusCode.OK);

    const steps = await listAgentSteps(db, runId);
    expect(steps).toHaveLength(2);
    expect(steps.find((s) => s.attempt === 1)!.status).toBe('failed');
    expect(steps.find((s) => s.attempt === 2)!.status).toBe('completed');
  });

  it('DB status and span status always agree (table-driven)', async () => {
    const cases: Array<{
      run: () => Promise<number>;
      dbStatus: string;
      spanStatus: SpanStatusCode;
    }> = [
      { run: () => Promise.resolve(1), dbStatus: 'completed', spanStatus: SpanStatusCode.OK },
      {
        run: () => Promise.reject(new Error('x')),
        dbStatus: 'failed',
        spanStatus: SpanStatusCode.ERROR,
      },
    ];

    for (const [i, { run, dbStatus, spanStatus }] of cases.entries()) {
      mockAttempt(1);
      await withStep(db, { documentId: 'doc-1', runId, ord: i }, 'extractAndChunk', run).catch(
        () => undefined,
      );

      const steps = await listAgentSteps(db, runId);
      const step = steps.find((s) => s.ord === i)!;
      expect(step.status).toBe(dbStatus);

      const span = exporter.getFinishedSpans().find((s) => s.attributes['agent_step.ord'] === i)!;
      expect(span.status.code).toBe(spanStatus);
    }
  });
});
