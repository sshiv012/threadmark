import { RetrievalValidationError } from '@threadmark/retrieval';
import type { Retriever } from '@threadmark/retrieval';
import type { Principal } from '@threadmark/core';
import { asSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createSearchEvidenceTool, SearchEvidenceToolError } from './searchEvidence.js';

const WORKSPACE_A = 'workspace-a';

function agentPrincipal(workspaceId: string): Principal {
  return { kind: 'agent_persona', subjectId: 'persona-1', workspaceId, role: 'viewer' };
}

function fakeRetriever(impl: Retriever['search']): Retriever {
  return { search: impl };
}

// Tool input schemas are wrapped in an opaque Schema type by the AI SDK — asSchema()/.validate()
// is the documented way to check them in a test, not a raw Zod .parse() call.
async function validateInput(schema: unknown, value: unknown) {
  const result = await asSchema(schema as never).validate!(value);
  if (!result.success) throw result.error;
  return result.value;
}

describe('search_evidence tool', () => {
  it('has an inputSchema containing only "query" — no workspaceId key at all', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => ({
          query: '',
          results: [],
          cached: false,
          latencyMs: 0,
        })),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    const parsed = await validateInput(tool.inputSchema, { query: 'q' });
    expect(Object.keys(parsed as object)).toEqual(['query']);
  });

  it('a raw args object with an injected workspaceId field never reaches retriever.search with that value — Zod strips the unknown key', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => ({
          query: '',
          results: [],
          cached: false,
          latencyMs: 0,
        })),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    const parsed = await validateInput(tool.inputSchema, {
      query: 'q',
      workspaceId: 'other-workspace',
    });
    expect(parsed).toEqual({ query: 'q' });
  });

  it('calls retriever.search with the closure-bound workspaceId, not anything from the tool input', async () => {
    const search = vi.fn(async () => ({ query: 'q', results: [], cached: false, latencyMs: 0 }));
    const tool = createSearchEvidenceTool(
      { retriever: fakeRetriever(search) },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    await tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} });
    expect(search).toHaveBeenCalledWith('q', { workspaceId: WORKSPACE_A });
  });

  it('throws a SearchEvidenceToolError with code "authorization_denied" when can() denies (cross-tenant principal)', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => ({
          query: '',
          results: [],
          cached: false,
          latencyMs: 0,
        })),
      },
      agentPrincipal('workspace-b'), // principal belongs to a different workspace than the call target
      WORKSPACE_A,
    );
    await expect(
      tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} }),
    ).rejects.toMatchObject({
      code: 'authorization_denied',
    });
  });

  it('throws a SearchEvidenceToolError with code "invalid_query" when the retriever throws RetrievalValidationError', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => {
          throw new RetrievalValidationError('query must be a non-empty, non-whitespace string');
        }),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    await expect(
      tool.execute!({ query: '   ' }, { toolCallId: 't1', messages: [], context: {} }),
    ).rejects.toMatchObject({
      code: 'invalid_query',
    });
  });

  it('throws a SearchEvidenceToolError with code "infrastructure_error" for any other thrown error', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => {
          throw new Error('ECONNREFUSED');
        }),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    await expect(
      tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} }),
    ).rejects.toMatchObject({
      code: 'infrastructure_error',
    });
  });

  it('never puts the raw infrastructure error message on the thrown error — it always reaches the next generation step, so a leaked connection string/SQL/credential would reach the model', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => {
          throw new Error('connection to postgres://app:s3cr3t@db.internal:5432/prod failed');
        }),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );

    await expect(
      tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} }),
    ).rejects.toMatchObject({
      code: 'infrastructure_error',
      message: expect.not.stringContaining('s3cr3t'),
    });
  });

  it('retains the real infrastructure error as `cause`, for internal callers/logging only', async () => {
    const originalError = new Error('ECONNREFUSED');
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => {
          throw originalError;
        }),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );

    let error: SearchEvidenceToolError | undefined;
    try {
      await tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} });
    } catch (caught) {
      error = caught as SearchEvidenceToolError;
    }

    expect(error?.cause).toBe(originalError);
  });

  it('checks can() before ever calling retriever.search — a denial never touches the retriever', async () => {
    const search = vi.fn(async () => ({ query: '', results: [], cached: false, latencyMs: 0 }));
    const tool = createSearchEvidenceTool(
      { retriever: fakeRetriever(search) },
      agentPrincipal('workspace-b'),
      WORKSPACE_A,
    );
    await expect(
      tool.execute!({ query: 'q' }, { toolCallId: 't1', messages: [], context: {} }),
    ).rejects.toBeInstanceOf(SearchEvidenceToolError);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns a real result shape (chunkId/documentTitle/snippet/score/sourceType) on success', async () => {
    const tool = createSearchEvidenceTool(
      {
        retriever: fakeRetriever(async () => ({
          query: 'q',
          cached: false,
          latencyMs: 1,
          results: [
            {
              chunkId: 'c1',
              documentId: 'd1',
              documentTitle: 'Doc',
              sourceType: 'product_doc',
              text: 'a'.repeat(500),
              rerankScore: 0.9,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })),
      },
      agentPrincipal(WORKSPACE_A),
      WORKSPACE_A,
    );
    const output = await tool.execute!(
      { query: 'q' },
      { toolCallId: 't1', messages: [], context: {} },
    );
    expect(output).toMatchObject({
      results: [
        {
          chunkId: 'c1',
          documentTitle: 'Doc',
          score: 0.9,
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceType: 'product_doc',
        },
      ],
    });
    expect(
      (output as { results: Array<{ snippet: string }> }).results[0]!.snippet.length,
    ).toBeLessThanOrEqual(400);
  });
});
