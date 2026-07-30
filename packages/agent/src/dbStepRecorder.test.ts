import type { Database } from '@threadmark/db';
import { appendAgentStep } from '@threadmark/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbStepRecorder } from './dbStepRecorder.js';
import type { RecordedStep } from './types.js';

vi.mock('@threadmark/db', () => ({
  appendAgentStep: vi.fn(),
}));

const FAKE_DB = {} as Database;
const RUN_ID = 'run-1';

const mockAppendAgentStep = vi.mocked(appendAgentStep);

beforeEach(() => {
  mockAppendAgentStep.mockReset();
  mockAppendAgentStep.mockResolvedValue({} as never);
});

describe('createDbStepRecorder', () => {
  it('maps a successful tool_call step to a single appendAgentStep insert with the final status already known', async () => {
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);
    const step: RecordedStep = {
      ord: 0,
      kind: 'tool_call',
      toolName: 'search_evidence',
      status: 'success',
    };

    await recorder.recordStep(step);

    expect(mockAppendAgentStep).toHaveBeenCalledTimes(1);
    expect(mockAppendAgentStep).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({
        runId: RUN_ID,
        ord: 0,
        type: 'search_evidence',
        attempt: 1,
        status: 'completed',
        error: null,
        errorCode: null,
      }),
    );
    const [, insertArg] = mockAppendAgentStep.mock.calls[0]!;
    expect((insertArg as { endedAt: Date }).endedAt).toBeInstanceOf(Date);
  });

  it('maps a failed tool_call step to status "failed" with the error and errorCode preserved', async () => {
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);
    const step: RecordedStep = {
      ord: 1,
      kind: 'tool_call',
      toolName: 'search_evidence',
      status: 'failed',
      error: 'not authorized to read evidence in this workspace',
      errorCode: 'authorization_denied',
    };

    await recorder.recordStep(step);

    expect(mockAppendAgentStep).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({
        status: 'failed',
        error: 'not authorized to read evidence in this workspace',
        errorCode: 'authorization_denied',
      }),
    );
  });

  it('distinguishes authorization_denied from infrastructure_error in what is persisted', async () => {
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);
    await recorder.recordStep({
      ord: 0,
      kind: 'tool_call',
      toolName: 'search_evidence',
      status: 'failed',
      error: 'ECONNREFUSED',
      errorCode: 'infrastructure_error',
    });

    expect(mockAppendAgentStep).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ errorCode: 'infrastructure_error' }),
    );
  });

  it('uses type "final_answer" for a final_answer step, distinct from the tool name used for tool_call steps', async () => {
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);
    await recorder.recordStep({ ord: 2, kind: 'final_answer', status: 'success' });

    expect(mockAppendAgentStep).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ type: 'final_answer' }),
    );
  });

  it('accepts ord=0 as a valid, non-rejected first step (not 1-indexed)', async () => {
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);
    await expect(
      recorder.recordStep({ ord: 0, kind: 'final_answer', status: 'success' }),
    ).resolves.toBeUndefined();
    expect(mockAppendAgentStep).toHaveBeenCalledWith(FAKE_DB, expect.objectContaining({ ord: 0 }));
  });

  it("does not swallow a broken appendAgentStep call itself — best-effort is the caller's (safeRecordStep's) responsibility, not duplicated here", async () => {
    mockAppendAgentStep.mockRejectedValueOnce(new Error('DB unreachable'));
    const recorder = createDbStepRecorder(FAKE_DB, RUN_ID);

    await expect(
      recorder.recordStep({ ord: 0, kind: 'final_answer', status: 'success' }),
    ).rejects.toThrow('DB unreachable');
  });
});
