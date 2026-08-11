import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import type { Principal } from '@threadmark/core';
import type { Retriever, RetrievedChunk } from '@threadmark/retrieval';
import { RetrievalValidationError } from '@threadmark/retrieval';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { runAgentQuery, type AgentQueryDeps } from './runAgentQuery.js';
import type { RecordedStep, StepRecorder } from './types.js';

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

function chunk(overrides: Partial<RetrievedChunk> & { chunkId: string }): RetrievedChunk {
  return {
    documentId: 'doc-1',
    documentTitle: 'Doc',
    sourceType: 'product_doc',
    text: 'evidence text',
    rerankScore: 0.9,
    ...overrides,
  };
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

/** Schema-invalid per the tool's real Zod inputSchema ({query: z.string()})
 *  — `query` is a number, not a string. The AI SDK rejects this BEFORE
 *  execute() ever runs (our execute() never sees it), unlike toolCallStep's
 *  well-typed-but-empty-string case, which reaches execute() and is
 *  rejected there by RetrievalValidationError instead. */
function schemaInvalidToolCallStep(): LanguageModelV4GenerateResult {
  return {
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: USAGE,
    content: [
      {
        type: 'tool-call',
        toolCallId: 't-invalid',
        toolName: 'search_evidence',
        input: JSON.stringify({ query: 42 }),
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

class InMemoryStepRecorder implements StepRecorder {
  steps: RecordedStep[] = [];
  recordStep(step: RecordedStep): void {
    this.steps.push(step);
  }
}

describe('runAgentQuery', () => {
  describe('happy path', () => {
    it('answers a general-knowledge question without ever calling search_evidence', async () => {
      const search = vi.fn();
      const model = new MockLanguageModelV4({
        doGenerate: async () => textStep('Paris is the capital of France.'),
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(
        deps,
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'capital of France?',
      );

      expect(answer).toEqual({
        answer: 'Paris is the capital of France.',
        citedChunkIds: [],
        unverifiedCitations: [],
        toolCalled: false,
      });
      expect(search).not.toHaveBeenCalled();
    });

    it('calls search_evidence once, cites a real returned chunk, and lands it in citedChunkIds', async () => {
      const search = vi.fn(async () => ({
        query: 'sharing',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: 'c1', text: 'sharing works via secure links' })],
      }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1
            ? toolCallStep('sharing')
            : textStep('Sharing works via secure links [chunk:c1].');
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(
        deps,
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'How does sharing work?',
      );

      expect(answer.toolCalled).toBe(true);
      expect(answer.citedChunkIds).toEqual(['c1']);
      expect(answer.unverifiedCitations).toEqual([]);
      expect(search).toHaveBeenCalledWith('sharing', { workspaceId: WORKSPACE_A });
    });

    it('accumulates and dedupes cited chunk ids across multiple tool calls returning overlapping chunks', async () => {
      const search = vi
        .fn()
        .mockResolvedValueOnce({
          query: 'a',
          cached: false,
          latencyMs: 1,
          results: [chunk({ chunkId: 'c1' }), chunk({ chunkId: 'c2' })],
        })
        .mockResolvedValueOnce({
          query: 'b',
          cached: false,
          latencyMs: 1,
          results: [chunk({ chunkId: 'c2' }), chunk({ chunkId: 'c3' })],
        });
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          if (callCount === 1) return toolCallStep('a');
          if (callCount === 2) return toolCallStep('b');
          return textStep('Summary [chunk:c1][chunk:c2][chunk:c2][chunk:c3].');
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(
        deps,
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'summarize everything',
      );

      expect(new Set(answer.citedChunkIds)).toEqual(new Set(['c1', 'c2', 'c3']));
      expect(answer.citedChunkIds).toHaveLength(3); // deduped, not 4
      expect(answer.unverifiedCitations).toEqual([]);
    });
  });

  describe('negative / adversarial', () => {
    it('does not crash when a cross-tenant principal makes can() deny the tool, and still returns an answer', async () => {
      const search = vi.fn();
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1
            ? toolCallStep('q')
            : textStep("I couldn't retrieve evidence for this workspace.");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      // principal belongs to workspace B, call targets workspace A — can()'s cross-tenant gate denies.
      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_B), WORKSPACE_A, 'q?');

      expect(answer.toolCalled).toBe(true);
      expect(search).not.toHaveBeenCalled();
    });

    it('classifies a [chunk:id] citation never returned by any tool call this run as unverifiedCitations', async () => {
      const search = vi.fn(async () => ({
        query: 'q',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: 'c1' })],
      }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1
            ? toolCallStep('q')
            : textStep('See [chunk:c1] and also [chunk:zzz-hallucinated].');
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      expect(answer.citedChunkIds).toEqual(['c1']);
      expect(answer.unverifiedCitations).toEqual(['zzz-hallucinated']);
    });

    it('classifies any [chunk:id] citation as unverified when the model answers without calling the tool at all', async () => {
      const search = vi.fn();
      const model = new MockLanguageModelV4({
        doGenerate: async () => textStep('[chunk:c1] says X.'),
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      expect(answer.toolCalled).toBe(false);
      expect(answer.citedChunkIds).toEqual([]);
      expect(answer.unverifiedCitations).toEqual(['c1']);
    });

    it('surfaces a RetrievalValidationError (empty tool-generated query) as a graceful tool-error, without crashing the run', async () => {
      const search = vi.fn(async () => {
        throw new RetrievalValidationError('query must be a non-empty, non-whitespace string');
      });
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('') : textStep("I couldn't retrieve evidence.");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      const answer = await runAgentQuery(
        deps,
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'a perfectly valid question',
      );

      expect(search).toHaveBeenCalled();
      expect(answer.answer).toContain("couldn't retrieve");
    });

    it('surfaces a whitespace-only tool-generated query the same way — reaches the retriever, is not pre-rejected by the Zod schema', async () => {
      const search = vi.fn(async () => {
        throw new RetrievalValidationError('query must be a non-empty, non-whitespace string');
      });
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('   ') : textStep("I couldn't retrieve evidence.");
        },
      });
      const deps: AgentQueryDeps = { retriever: fakeRetriever(search), model };

      await runAgentQuery(
        deps,
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'a perfectly valid question',
      );

      expect(search).toHaveBeenCalledWith('   ', { workspaceId: WORKSPACE_A });
    });

    it('classifies a schema-invalid tool call (query: 42, not a string — rejected by the AI SDK before execute() runs) as invalid_query, and completes the run gracefully rather than failing it', async () => {
      const search = vi.fn();
      const recorder = new InMemoryStepRecorder();
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1
            ? schemaInvalidToolCallStep()
            : textStep("I couldn't retrieve evidence.");
        },
      });
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: recorder,
      };

      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      expect(search).not.toHaveBeenCalled();
      expect(answer.answer).toContain("couldn't retrieve");
      expect(recorder.steps[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_query' });
      expect(recorder.steps.some((s) => s.kind === 'final_answer')).toBe(true);
    });
  });

  describe('multi-tenant isolation', () => {
    it('two runs against different workspaceIds with the same mocked model never leak result content across each other', async () => {
      const search = vi.fn(async (_query: string, options: { workspaceId: string }) => ({
        query: 'q',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: options.workspaceId === WORKSPACE_A ? 'a1' : 'b1' })],
      }));
      const scriptedModel = () => {
        let callCount = 0;
        return new MockLanguageModelV4({
          doGenerate: async () => {
            callCount += 1;
            if (callCount === 1) return toolCallStep('q');
            const lastCall = search.mock.calls.at(-1)!;
            const ws = (lastCall[1] as { workspaceId: string }).workspaceId;
            return textStep(`Found [chunk:${ws === WORKSPACE_A ? 'a1' : 'b1'}].`);
          },
        });
      };

      const answerA = await runAgentQuery(
        { retriever: fakeRetriever(search), model: scriptedModel() },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );
      const answerB = await runAgentQuery(
        { retriever: fakeRetriever(search), model: scriptedModel() },
        agentPrincipal(WORKSPACE_B),
        WORKSPACE_B,
        'q?',
      );

      expect(answerA.citedChunkIds).toEqual(['a1']);
      expect(answerB.citedChunkIds).toEqual(['b1']);
      expect(search).toHaveBeenNthCalledWith(1, 'q', { workspaceId: WORKSPACE_A });
      expect(search).toHaveBeenNthCalledWith(2, 'q', { workspaceId: WORKSPACE_B });
    });
  });

  describe('failure / degradation', () => {
    it('records a FAILED step for a can() denial, but resolves the run normally', async () => {
      const search = vi.fn();
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('q') : textStep("I couldn't retrieve evidence.");
        },
      });
      const recorder = new InMemoryStepRecorder();
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: recorder,
      };

      await runAgentQuery(deps, agentPrincipal(WORKSPACE_B), WORKSPACE_A, 'q?');

      const toolStep = recorder.steps.find((s) => s.kind === 'tool_call');
      expect(toolStep).toMatchObject({ status: 'failed', errorCode: 'authorization_denied' });
    });

    it('records the infrastructure failure as a failed step BEFORE rejecting the whole run, and does not swallow it as "no evidence found"', async () => {
      const search = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      const model = new MockLanguageModelV4({
        doGenerate: async () => toolCallStep('q'),
      });
      const recorder = new InMemoryStepRecorder();
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: recorder,
      };

      await expect(
        runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?'),
      ).rejects.toThrow();

      const toolStep = recorder.steps.find((s) => s.kind === 'tool_call');
      expect(toolStep).toMatchObject({ status: 'failed', errorCode: 'infrastructure_error' });
      // Resolved-only invariant: a rejected run records no final-answer step.
      expect(recorder.steps.find((s) => s.kind === 'final_answer')).toBeUndefined();
    });

    it('never conflates a can()-denial failed step with a genuine-infra-error failed step', async () => {
      const denialSearch = vi.fn();
      let denialCallCount = 0;
      const denialModel = new MockLanguageModelV4({
        doGenerate: async () => {
          denialCallCount += 1;
          return denialCallCount === 1 ? toolCallStep('q') : textStep('no evidence');
        },
      });
      const denialRecorder = new InMemoryStepRecorder();
      await runAgentQuery(
        {
          retriever: fakeRetriever(denialSearch),
          model: denialModel,
          stepRecorder: denialRecorder,
        },
        agentPrincipal(WORKSPACE_B),
        WORKSPACE_A,
        'q?',
      );

      const infraSearch = vi.fn(async () => {
        throw new Error('boom');
      });
      const infraModel = new MockLanguageModelV4({ doGenerate: async () => toolCallStep('q') });
      const infraRecorder = new InMemoryStepRecorder();
      await expect(
        runAgentQuery(
          { retriever: fakeRetriever(infraSearch), model: infraModel, stepRecorder: infraRecorder },
          agentPrincipal(WORKSPACE_A),
          WORKSPACE_A,
          'q?',
        ),
      ).rejects.toThrow();

      expect(denialRecorder.steps[0]?.errorCode).toBe('authorization_denied');
      expect(infraRecorder.steps[0]?.errorCode).toBe('infrastructure_error');
      expect(denialRecorder.steps[0]?.errorCode).not.toBe(infraRecorder.steps[0]?.errorCode);
    });

    it('does not fail the run when stepRecorder.recordStep() itself throws (observability is best-effort)', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      const model = new MockLanguageModelV4({ doGenerate: async () => textStep('an answer') });
      const brokenRecorder: StepRecorder = {
        recordStep: () => {
          throw new Error('recorder is down');
        },
      };
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: brokenRecorder,
      };

      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      expect(answer.answer).toBe('an answer');
    });

    it('does not fail the run when an ASYNC stepRecorder.recordStep() rejects (a real DB-backed recorder can reject a promise, not just throw synchronously)', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      const model = new MockLanguageModelV4({ doGenerate: async () => textStep('an answer') });
      const brokenAsyncRecorder: StepRecorder = {
        recordStep: async () => {
          throw new Error('DB unreachable');
        },
      };
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: brokenAsyncRecorder,
      };

      const answer = await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      expect(answer.answer).toBe('an answer');
    });

    it('awaits an async stepRecorder.recordStep() — runAgentQuery does not return before every recorded write actually lands', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      const model = new MockLanguageModelV4({ doGenerate: async () => textStep('an answer') });
      const recorded: RecordedStep[] = [];
      const slowAsyncRecorder: StepRecorder = {
        recordStep: async (step) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          recorded.push(step);
        },
      };
      const deps: AgentQueryDeps = {
        retriever: fakeRetriever(search),
        model,
        stepRecorder: slowAsyncRecorder,
      };

      await runAgentQuery(deps, agentPrincipal(WORKSPACE_A), WORKSPACE_A, 'q?');

      // If safeRecordStep failed to await the promise, this would still be
      // empty here — the write would still be in flight.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ kind: 'final_answer', status: 'success' });
    });
  });

  describe('provenance / correctness', () => {
    it('increments ord starting at 0 across multiple tool calls in a single run', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          if (callCount <= 2) return toolCallStep(`q${callCount}`);
          return textStep('final');
        },
      });
      const recorder = new InMemoryStepRecorder();
      await runAgentQuery(
        { retriever: fakeRetriever(search), model, stepRecorder: recorder },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(recorder.steps.map((s) => s.ord)).toEqual([0, 1, 2]);
    });

    it('records exactly one final-answer step for a resolved run, regardless of tool-call count', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          if (callCount <= 2) return toolCallStep(`q${callCount}`);
          return textStep('final');
        },
      });
      const recorder = new InMemoryStepRecorder();
      await runAgentQuery(
        { retriever: fakeRetriever(search), model, stepRecorder: recorder },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(recorder.steps.filter((s) => s.kind === 'final_answer')).toHaveLength(1);
    });

    it('does not leak the ord counter across two separate runAgentQuery calls sharing one stepRecorder instance', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      const recorder = new InMemoryStepRecorder();
      const makeModel = () => {
        let callCount = 0;
        return new MockLanguageModelV4({
          doGenerate: async () => {
            callCount += 1;
            return callCount === 1 ? toolCallStep('q') : textStep('final');
          },
        });
      };

      await runAgentQuery(
        { retriever: fakeRetriever(search), model: makeModel(), stepRecorder: recorder },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'first?',
      );
      const firstRunOrds = recorder.steps.map((s) => s.ord);
      recorder.steps = [];
      await runAgentQuery(
        { retriever: fakeRetriever(search), model: makeModel(), stepRecorder: recorder },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'second?',
      );

      expect(firstRunOrds[0]).toBe(0);
      expect(recorder.steps[0]?.ord).toBe(0);
    });

    it('deduplicates a citation marker repeated multiple times into a single citedChunkIds entry', async () => {
      const search = vi.fn(async () => ({
        query: 'q',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: 'c1' })],
      }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('q') : textStep('[chunk:c1] and again [chunk:c1].');
        },
      });
      const answer = await runAgentQuery(
        { retriever: fakeRetriever(search), model },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(answer.citedChunkIds).toEqual(['c1']);
    });

    it('does not treat a malformed empty marker "[chunk:]" as a citation at all', async () => {
      const model = new MockLanguageModelV4({
        doGenerate: async () => textStep('See [chunk:] for details.'),
      });
      const answer = await runAgentQuery(
        { retriever: fakeRetriever(vi.fn()), model },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(answer.citedChunkIds).toEqual([]);
      expect(answer.unverifiedCitations).toEqual([]);
    });

    it('correctly extracts a UUID-shaped chunk id from a citation marker', async () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const search = vi.fn(async () => ({
        query: 'q',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: uuid })],
      }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1 ? toolCallStep('q') : textStep(`See [chunk:${uuid}].`);
        },
      });
      const answer = await runAgentQuery(
        { retriever: fakeRetriever(search), model },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(answer.citedChunkIds).toEqual([uuid]);
    });

    it('citedChunkIds and unverifiedCitations are mutually exclusive', async () => {
      const search = vi.fn(async () => ({
        query: 'q',
        cached: false,
        latencyMs: 1,
        results: [chunk({ chunkId: 'c1' })],
      }));
      let callCount = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          callCount += 1;
          return callCount === 1
            ? toolCallStep('q')
            : textStep('[chunk:c1] and [chunk:c2] and [chunk:c1].');
        },
      });
      const answer = await runAgentQuery(
        { retriever: fakeRetriever(search), model },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      const overlap = answer.citedChunkIds.filter((id) => answer.unverifiedCitations.includes(id));
      expect(overlap).toEqual([]);
      expect(answer.citedChunkIds).toEqual(['c1']);
      expect(answer.unverifiedCitations).toEqual(['c2']);
    });
  });

  describe('UX states', () => {
    it('rejects immediately when question is an empty string, without calling the model or the retriever', async () => {
      const doGenerate = vi.fn();
      const search = vi.fn();
      const model = new MockLanguageModelV4({ doGenerate });

      await expect(
        runAgentQuery(
          { retriever: fakeRetriever(search), model },
          agentPrincipal(WORKSPACE_A),
          WORKSPACE_A,
          '',
        ),
      ).rejects.toThrow(/non-empty/);
      expect(doGenerate).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    });

    it('rejects immediately when question is whitespace-only', async () => {
      const doGenerate = vi.fn();
      const model = new MockLanguageModelV4({ doGenerate });

      await expect(
        runAgentQuery(
          { retriever: fakeRetriever(vi.fn()), model },
          agentPrincipal(WORKSPACE_A),
          WORKSPACE_A,
          '   ',
        ),
      ).rejects.toThrow(/non-empty/);
      expect(doGenerate).not.toHaveBeenCalled();
    });
  });

  describe('non-functional bounds', () => {
    it('stops the tool-calling loop at the step cap even when the model always requests another tool call, and resolves without hanging', async () => {
      const search = vi.fn(async () => ({ query: '', cached: false, latencyMs: 0, results: [] }));
      const model = new MockLanguageModelV4({
        doGenerate: async () => toolCallStep('again'), // never returns finishReason: 'stop'
      });
      const recorder = new InMemoryStepRecorder();

      const answer = await runAgentQuery(
        { retriever: fakeRetriever(search), model, stepRecorder: recorder },
        agentPrincipal(WORKSPACE_A),
        WORKSPACE_A,
        'q?',
      );

      expect(answer).toBeDefined();
      expect(search.mock.calls.length).toBeLessThanOrEqual(5);
      expect(search.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
