import type { Principal } from '@threadmark/core';
import type { Retriever } from '@threadmark/retrieval';
import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { createSearchEvidenceTool, SearchEvidenceToolError } from './tools/searchEvidence.js';
import type { AgentAnswer, RecordedStep, StepErrorCode, StepRecorder } from './types.js';

export interface AgentQueryDeps {
  readonly retriever: Retriever;
  readonly model: LanguageModel;
  readonly stepRecorder?: StepRecorder;
}

// A single-tool, single-turn Q&A persona, not a multi-step planner — 5 model
// invocations is generous headroom (a couple of evidence lookups plus a
// final answer) while still guaranteeing the loop terminates even if the
// model insists on calling the tool repeatedly.
const MAX_MODEL_STEPS = 5;

const CITATION_PATTERN = /\[chunk:([^\]\s]+)\]/g;

const PERSONA_PROMPT =
  'You are a research assistant answering questions using only the workspace evidence corpus. ' +
  'Call search_evidence to look up relevant evidence before answering a question that depends on ' +
  'workspace-specific facts. You do not need to call it for questions answerable from general reasoning. ' +
  'Every claim that depends on retrieved evidence must cite the exact chunk it came from using a ' +
  '[chunk:<id>] marker immediately after the claim. Never cite a chunk id you were not given by a ' +
  'search_evidence result. If search_evidence is unavailable or denied, say so plainly rather than ' +
  'guessing.';

function extractCitations(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Observability is best-effort: a broken recorder must never fail an
 *  otherwise-successful run, the same way this codebase's telemetry
 *  (withSpan) stays safe even if the tracer itself is broken. Always
 *  awaited: `StepRecorder.recordStep` may return a promise (a real
 *  DB-backed recorder does), and an unawaited rejection would both escape
 *  this try/catch and let `runAgentQuery` return before the write lands. */
async function safeRecordStep(
  recorder: StepRecorder | undefined,
  step: RecordedStep,
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.recordStep(step);
  } catch (error) {
    console.warn('[agent] stepRecorder.recordStep threw, continuing:', error);
  }
}

/**
 * Runs a single cited-Q&A turn. Fails fast on an empty/whitespace question
 * (mirrors packages/retrieval's own validateSearchInput precedent) — never
 * burns a model call on a request that's definitionally empty.
 *
 * After generation, every step's content is inspected for `search_evidence`
 * tool-error/tool-result parts: a thrown execute() error does NOT by itself
 * reject generateText() (the AI SDK converts it into a tool-error step part
 * and lets the model continue) — so an 'infrastructure_error'-tagged
 * tool-error is explicitly re-thrown here, AFTER generation completes, to
 * make the whole run reject. 'authorization_denied'/'invalid_query' tool
 * errors are NOT re-thrown — the gate/validation working correctly isn't a
 * run failure, and the model's own text (acknowledging it couldn't retrieve
 * evidence) is still a valid answer.
 */
export async function runAgentQuery(
  deps: AgentQueryDeps,
  principal: Principal,
  workspaceId: string,
  question: string,
): Promise<AgentAnswer> {
  if (question.trim() === '') {
    throw new Error('question must be a non-empty, non-whitespace string');
  }

  const searchEvidence = createSearchEvidenceTool(
    { retriever: deps.retriever },
    principal,
    workspaceId,
  );

  const result = await generateText({
    model: deps.model,
    system: PERSONA_PROMPT,
    prompt: question,
    tools: { search_evidence: searchEvidence },
    stopWhen: stepCountIs(MAX_MODEL_STEPS),
  });

  let ord = 0;
  let toolCalled = false;
  const returnedChunkIds = new Set<string>();
  let infrastructureFailure: SearchEvidenceToolError | undefined;

  for (const step of result.steps) {
    for (const part of step.content) {
      if (!('toolName' in part) || part.toolName !== 'search_evidence') continue;

      if (part.type === 'tool-result') {
        toolCalled = true;
        const output = part.output as { results: Array<{ chunkId: string }> };
        for (const r of output.results) returnedChunkIds.add(r.chunkId);
        await safeRecordStep(deps.stepRecorder, {
          ord: ord++,
          kind: 'tool_call',
          toolName: 'search_evidence',
          status: 'success',
        });
      } else if (part.type === 'tool-error') {
        toolCalled = true;
        const err = part.error;
        let code: StepErrorCode;
        if (err instanceof SearchEvidenceToolError) {
          code = err.code;
        } else if (typeof err === 'string') {
          // The AI SDK rejects a schema-invalid tool call (e.g. the model
          // emitted a non-string `query`) before execute() ever runs, and
          // represents it here as a plain string — never our own error
          // type, since our code never touched it. This is a malformed
          // request from the model, not a broken retriever/backend.
          code = 'invalid_query';
        } else {
          code = 'infrastructure_error';
        }
        await safeRecordStep(deps.stepRecorder, {
          ord: ord++,
          kind: 'tool_call',
          toolName: 'search_evidence',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          errorCode: code,
        });
        if (code === 'infrastructure_error' && !infrastructureFailure) {
          infrastructureFailure =
            err instanceof SearchEvidenceToolError
              ? err
              : new SearchEvidenceToolError(String(err), 'infrastructure_error');
        }
      }
    }
  }

  if (infrastructureFailure) {
    throw infrastructureFailure;
  }

  await safeRecordStep(deps.stepRecorder, { ord: ord++, kind: 'final_answer', status: 'success' });

  const allCitations = extractCitations(result.text);
  const citedChunkIds = allCitations.filter((id) => returnedChunkIds.has(id));
  const unverifiedCitations = allCitations.filter((id) => !returnedChunkIds.has(id));

  return { answer: result.text, citedChunkIds, unverifiedCitations, toolCalled };
}
