import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { Principal } from '@threadmark/core';
import {
  appendAgentStep,
  createAgentRun,
  updateAgentRunStatus,
  type Database,
} from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentQuery, type AgentQueryDeps } from './runAgentQuery.js';

// This file exercises runAgentQuery's DB-bracketing best-effort behavior —
// createAgentRun/updateAgentRunStatus/appendAgentStep are mocked so we can
// force them to reject without standing up a real database. See
// runAgentQuery.integration.test.ts for the real-pglite-backed happy path
// and isolation tests, which cannot share a file with this one (the mock
// here would shadow the real implementation those tests need).
vi.mock('@threadmark/db', () => ({
  createAgentRun: vi.fn(),
  updateAgentRunStatus: vi.fn(),
  appendAgentStep: vi.fn(),
}));

const mockCreateAgentRun = vi.mocked(createAgentRun);
const mockUpdateAgentRunStatus = vi.mocked(updateAgentRunStatus);
const mockAppendAgentStep = vi.mocked(appendAgentStep);

const FAKE_DB = {} as Database;
const WORKSPACE_A = 'workspace-a';
const WORKSPACE_B = 'workspace-b';

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

beforeEach(() => {
  mockCreateAgentRun.mockReset();
  mockUpdateAgentRunStatus.mockReset();
  mockAppendAgentStep.mockReset();
  mockCreateAgentRun.mockResolvedValue({ id: 'run-1' } as never);
  mockUpdateAgentRunStatus.mockResolvedValue({} as never);
  mockAppendAgentStep.mockResolvedValue({} as never);
});

describe('runAgentQuery — best-effort DB observability', () => {
  it('never calls createAgentRun for a cross-tenant principal, even when db is provided — the upfront authorization gate skips the DB write entirely rather than writing then relying on the tool to deny', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textStep("I couldn't retrieve evidence for this workspace."),
    });
    const deps: AgentQueryDeps = { retriever: fakeRetriever(vi.fn()), model, db: FAKE_DB };

    // principal belongs to workspace B, call targets workspace A.
    await runAgentQuery(deps, agentPrincipal(WORKSPACE_B), WORKSPACE_A, 'q?');

    expect(mockCreateAgentRun).not.toHaveBeenCalled();
  });

  it('marks the run failed when generateText() itself rejects, and still propagates the ORIGINAL error even if updateAgentRunStatus also fails', async () => {
    mockUpdateAgentRunStatus.mockRejectedValueOnce(new Error('DB unreachable'));
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const deps: AgentQueryDeps = { retriever: fakeRetriever(vi.fn()), model, db: FAKE_DB };

    await expect(
      runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?'),
    ).rejects.toThrow('ECONNREFUSED');

    expect(mockUpdateAgentRunStatus).toHaveBeenCalledWith(
      FAKE_DB,
      'run-1',
      'failed',
      expect.any(Date),
    );
  });

  it('still returns a valid answer when createAgentRun throws at the very start (DB unreachable)', async () => {
    mockCreateAgentRun.mockRejectedValueOnce(new Error('DB unreachable'));
    const model = new MockLanguageModelV4({
      doGenerate: async () => textStep('Paris is the capital of France.'),
    });
    const deps: AgentQueryDeps = { retriever: fakeRetriever(vi.fn()), model, db: FAKE_DB };

    const answer = await runAgentQuery(
      deps,
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
      'capital of France?',
    );

    expect(answer.answer).toBe('Paris is the capital of France.');
    // No run row exists (createAgentRun rejected), so no step/status writes are attempted for it.
    expect(mockAppendAgentStep).not.toHaveBeenCalled();
    expect(mockUpdateAgentRunStatus).not.toHaveBeenCalled();
  });

  it('still returns a valid answer when updateAgentRunStatus throws at the end (DB down after a successful answer)', async () => {
    mockUpdateAgentRunStatus.mockRejectedValueOnce(new Error('DB unreachable'));
    const model = new MockLanguageModelV4({
      doGenerate: async () => textStep('Paris is the capital of France.'),
    });
    const deps: AgentQueryDeps = { retriever: fakeRetriever(vi.fn()), model, db: FAKE_DB };

    const answer = await runAgentQuery(
      deps,
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
      'capital of France?',
    );

    expect(answer.answer).toBe('Paris is the capital of France.');
    expect(mockUpdateAgentRunStatus).toHaveBeenCalledWith(
      FAKE_DB,
      'run-1',
      'completed',
      expect.any(Date),
    );
  });

  it('a broken appendAgentStep on the first tool_call step does not prevent later steps (ord 1, final_answer) from still being recorded', async () => {
    mockAppendAgentStep.mockRejectedValueOnce(new Error('DB unreachable'));
    const search = vi.fn(async () => ({ query: 'q', cached: false, latencyMs: 1, results: [] }));
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount += 1;
        return callCount === 1 ? toolCallStep('q') : textStep('No evidence found.');
      },
    });
    const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model, db: FAKE_DB };

    const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

    expect(answer.answer).toBe('No evidence found.');
    // ord 0 (the tool_call step) rejected; ord 1 (final_answer) must still have been attempted.
    expect(mockAppendAgentStep).toHaveBeenCalledTimes(2);
    expect(mockAppendAgentStep.mock.calls[1]![1]).toMatchObject({ ord: 1, type: 'final_answer' });
  });
});
