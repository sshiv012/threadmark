import { fileURLToPath } from 'node:url';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Principal } from '@threadmark/core';
import * as dbSchema from '@threadmark/db';
import {
  createWorkspace,
  getAgentRun,
  listAgentRuns,
  listAgentSteps,
  type Database,
} from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentQuery, type AgentQueryDeps } from './runAgentQuery.js';

// Real Postgres (pglite) exercising the actual migration — proves FK
// constraints, the CHECK constraint on subjectId, and row shapes for real,
// not through mocks. Mirrors packages/db/src/db.test.ts's own setup exactly.
const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));

let db: Database;

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema: dbSchema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb;
});

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function agentPrincipal(workspaceId: string): Principal {
  return { kind: 'agent_persona', subjectId: 'persona-1', workspaceId, role: 'viewer' };
}

function fakeRetriever(impl: Retriever['search']): Retriever {
  return { search: impl };
}

function toolCallStep(query: string): LanguageModelV4GenerateResult {
  return {
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: USAGE,
    content: [
      {
        type: 'tool-call',
        toolCallId: `t-${query}`,
        toolName: 'search_evidence',
        input: JSON.stringify({ query }),
      },
    ],
    warnings: [],
  };
}

function textStep(text: string): LanguageModelV4GenerateResult {
  return {
    finishReason: { unified: 'stop', raw: undefined },
    usage: USAGE,
    content: [{ type: 'text', text }],
    warnings: [],
  };
}

function textOnlyModel(text: string) {
  return new MockLanguageModelV4({ doGenerate: async () => textStep(text) });
}

describe('runAgentQuery — real DB-backed observability', () => {
  describe('happy path', () => {
    it('records one agent_runs row (kind=qa, subjectId=null, status=completed) and one final_answer agent_steps row for a run with no tool calls', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const model = textOnlyModel('Paris is the capital of France.');
      const deps: AgentQueryDeps = { retriever: fakeRetriever(vi.fn()), model, db };

      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'capital of France?');

      const runs = await listAgentRuns(db, workspace.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        workspaceId: workspace.id,
        kind: 'qa',
        subjectId: null,
        status: 'completed',
      });
      expect(runs[0]!.endedAt).not.toBeNull();

      const steps = await listAgentSteps(db, runs[0]!.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        ord: 0,
        type: 'final_answer',
        status: 'completed',
        attempt: 1,
      });
    });

    it('persists agent_steps in ord order: two tool_call rows then the final_answer row', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const search = vi
        .fn()
        .mockResolvedValueOnce({ query: 'a', cached: false, latencyMs: 1, results: [] })
        .mockResolvedValueOnce({ query: 'b', cached: false, latencyMs: 1, results: [] });
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          if (callCount === 1) return toolCallStep('a');
          if (callCount === 2) return toolCallStep('b');
          return textStep('done');
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db };

      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q?');

      const [run] = await listAgentRuns(db, workspace.id);
      const steps = await listAgentSteps(db, run!.id);
      expect(steps.map((s) => [s.ord, s.type, s.status, s.attempt])).toEqual([
        [0, 'search_evidence', 'completed', 1],
        [1, 'search_evidence', 'completed', 1],
        [2, 'final_answer', 'completed', 1],
      ]);
    });
  });

  describe('multi-tenant isolation (hard gate)', () => {
    it("a cross-tenant principal (principal.workspaceId=B, call workspaceId=A) writes agent_runs.workspaceId as A — the call target, never B, the principal's own workspace", async () => {
      const wsA = await createWorkspace(db, { name: 'A' });
      const wsB = await createWorkspace(db, { name: 'B' });
      const search = vi.fn();
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('q') : textStep("couldn't retrieve evidence");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db };

      // principal belongs to workspace B, call targets workspace A — can()'s cross-tenant gate denies the tool.
      await runAgentQuery(deps, agentPrincipal(wsB.id), wsA.id, 'q?');

      expect(await listAgentRuns(db, wsA.id)).toHaveLength(1);
      expect(await listAgentRuns(db, wsB.id)).toHaveLength(0);
    });

    it('two concurrent runAgentQuery calls against workspace A and workspace B never cross-write agent_runs/agent_steps rows', async () => {
      const wsA = await createWorkspace(db, { name: 'A' });
      const wsB = await createWorkspace(db, { name: 'B' });
      const depsFor = (ws: { id: string }): AgentQueryDeps => ({
        retriever: fakeRetriever(vi.fn()),
        model: textOnlyModel(`answer for ${ws.id}`),
        db,
      });

      await Promise.all([
        runAgentQuery(depsFor(wsA), agentPrincipal(wsA.id), wsA.id, 'qA?'),
        runAgentQuery(depsFor(wsB), agentPrincipal(wsB.id), wsB.id, 'qB?'),
      ]);

      const runsA = await listAgentRuns(db, wsA.id);
      const runsB = await listAgentRuns(db, wsB.id);
      expect(runsA).toHaveLength(1);
      expect(runsB).toHaveLength(1);
      expect(runsA[0]!.id).not.toBe(runsB[0]!.id);

      const stepsA = await listAgentSteps(db, runsA[0]!.id);
      const stepsB = await listAgentSteps(db, runsB[0]!.id);
      expect(stepsA.every((s) => s.runId === runsA[0]!.id)).toBe(true);
      expect(stepsB.every((s) => s.runId === runsB[0]!.id)).toBe(true);
    });
  });

  describe('failure / degradation — reflected in real run/step status', () => {
    it('a can()-denial tool-call step is persisted as agent_steps.status=failed but agent_runs.status ends completed', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const otherWorkspace = await createWorkspace(db, { name: 'Other' });
      const search = vi.fn();
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('q') : textStep("couldn't retrieve evidence");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db };

      // principal belongs to a different workspace than the call target — can() denies.
      await runAgentQuery(deps, agentPrincipal(otherWorkspace.id), workspace.id, 'q?');

      const [run] = await listAgentRuns(db, workspace.id);
      expect(run).toMatchObject({ status: 'completed' });
      const steps = await listAgentSteps(db, run!.id);
      expect(steps[0]).toMatchObject({ status: 'failed', errorCode: 'authorization_denied' });
      expect(steps[1]).toMatchObject({ status: 'completed', type: 'final_answer' });
      expect(search).not.toHaveBeenCalled();
    });

    it('an infrastructure_error tool-call step is persisted as agent_steps.status=failed AND agent_runs.status ends failed with endedAt set', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const search = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          // The model isn't told the tool failed until after generation completes
          // (a tool-error doesn't stop the loop by itself) — script it to answer
          // on the second turn so exactly one failing step is produced.
          return callCount === 1 ? toolCallStep('q') : textStep("couldn't retrieve evidence");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db };

      await expect(
        runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q?'),
      ).rejects.toThrow();

      const [run] = await listAgentRuns(db, workspace.id);
      expect(run).toMatchObject({ status: 'failed' });
      expect(run!.endedAt).not.toBeNull();
      const steps = await listAgentSteps(db, run!.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ status: 'failed', errorCode: 'infrastructure_error' });
    });
  });

  describe('edge / boundary / validation', () => {
    it('an empty/whitespace-only question throws before any DB write — no orphan agent_runs row', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(vi.fn()),
        model: textOnlyModel('x'),
        db,
      };

      await expect(
        runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, '   '),
      ).rejects.toThrow();

      expect(await listAgentRuns(db, workspace.id)).toHaveLength(0);
    });

    it('the MAX_MODEL_STEPS cap (5) bounds agent_steps row count when the model always requests another tool call', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const search = vi.fn(async () => ({ query: 'q', cached: false, latencyMs: 1, results: [] }));
      const model = new MockLanguageModelV4({ doGenerate: async () => toolCallStep('q') });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db };

      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q?');

      const [run] = await listAgentRuns(db, workspace.id);
      const steps = await listAgentSteps(db, run!.id);
      // 5 tool_call attempts (the cap) + 1 final_answer, never unbounded.
      expect(steps.length).toBeLessThanOrEqual(6);
      expect(steps.every((s) => s.status === 'completed')).toBe(true);
    });
  });

  describe('re-run idempotency', () => {
    it("two sequential calls create two independent agent_runs rows, and the second run's ord counter starts at 0 again", async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(vi.fn()),
        model: textOnlyModel('answer'),
        db,
      };

      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q1?');
      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q2?');

      const runs = await listAgentRuns(db, workspace.id);
      expect(runs).toHaveLength(2);
      expect(runs[0]!.id).not.toBe(runs[1]!.id);

      const stepsRun1 = await listAgentSteps(db, runs[0]!.id);
      const stepsRun2 = await listAgentSteps(db, runs[1]!.id);
      expect(stepsRun1[0]!.ord).toBe(0);
      expect(stepsRun2[0]!.ord).toBe(0);
    });
  });

  describe('DB write prerequisites (schema-level)', () => {
    it('round-trips a kind=qa run with a null subjectId via getAgentRun', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(vi.fn()),
        model: textOnlyModel('answer'),
        db,
      };

      await runAgentQuery(deps, agentPrincipal(workspace.id), workspace.id, 'q?');

      const [run] = await listAgentRuns(db, workspace.id);
      const fetched = await getAgentRun(db, run!.id);
      expect(fetched).toMatchObject({ kind: 'qa', subjectId: null });
    });
  });
});
