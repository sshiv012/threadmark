import type { Database } from '@threadmark/db';
import { getConflictPolicy } from '@threadmark/db';
import { describe, expect, it, vi } from 'vitest';
import { fetchConflictPolicy, renderPolicyInstruction, type ConflictPolicy } from './policy.js';

vi.mock('@threadmark/db', () => ({
  getConflictPolicy: vi.fn(),
}));

const mockGetConflictPolicy = vi.mocked(getConflictPolicy);
const FAKE_DB = {} as Database;

describe('renderPolicyInstruction', () => {
  it('renders a distinguishable instruction per strategy', () => {
    const mostRecent = renderPolicyInstruction({ strategy: 'most_recent', config: {} });
    const flagForReview = renderPolicyInstruction({ strategy: 'flag_for_review', config: {} });
    const highestPriority = renderPolicyInstruction({
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: ['prior_prd'] },
    });

    expect(mostRecent).toMatch(/latest creation date/);
    expect(flagForReview).toMatch(/do not pick one/);
    expect(highestPriority).toMatch(/priority order/);
    expect(new Set([mostRecent, flagForReview, highestPriority]).size).toBe(3);
  });

  it('renders the same flag_for_review instruction for the synthesized default as for an explicit row', () => {
    const synthesizedDefault = renderPolicyInstruction({ strategy: 'flag_for_review', config: {} });
    const explicit = renderPolicyInstruction({ strategy: 'flag_for_review', config: {} });
    expect(synthesizedDefault).toBe(explicit);
  });

  it('highest_priority_source renders sourceTypePriority in the exact order given, not sorted', () => {
    const config = { sourceTypePriority: ['tech_constraint', 'prior_prd', 'product_doc'] };
    const instruction = renderPolicyInstruction({ strategy: 'highest_priority_source', config });
    const indices = config.sourceTypePriority.map((t) => instruction.indexOf(t));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(instruction).toMatch(/tech_constraint, prior_prd, product_doc/);
  });

  it('highest_priority_source with a single-entry priority list is NOT treated as "no priority"', () => {
    const instruction = renderPolicyInstruction({
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: ['product_doc'] },
    });
    expect(instruction).toMatch(/priority order: product_doc/);
  });

  it.each([
    ['missing sourceTypePriority', {}],
    ['empty sourceTypePriority array', { sourceTypePriority: [] }],
    ['non-array sourceTypePriority', { sourceTypePriority: 'product_doc' }],
    ['null config', null],
  ])(
    'falls back to flag_for_review-style language when config is malformed: %s',
    (_label, config) => {
      const instruction = renderPolicyInstruction({
        strategy: 'highest_priority_source',
        config: config as unknown,
      });
      expect(instruction).toMatch(/do not pick one/);
    },
  );

  it('is a pure function: identical input produces byte-identical output across repeated calls', () => {
    const policy: ConflictPolicy = { strategy: 'most_recent', config: {} };
    expect(renderPolicyInstruction(policy)).toBe(renderPolicyInstruction(policy));
  });

  it('has no hidden state across calls with different policies', () => {
    const first = renderPolicyInstruction({ strategy: 'most_recent', config: {} });
    renderPolicyInstruction({ strategy: 'flag_for_review', config: {} });
    const third = renderPolicyInstruction({ strategy: 'most_recent', config: {} });
    expect(first).toBe(third);
  });

  it('[documented limitation] the most_recent instruction is worded around creation/ingestion date, not "the actual most recent version"', () => {
    const instruction = renderPolicyInstruction({ strategy: 'most_recent', config: {} });
    expect(instruction).toMatch(/creation date/);
    expect(instruction).not.toMatch(/actual most recent/i);
  });
});

describe('fetchConflictPolicy', () => {
  it('is a thin wrapper — a getConflictPolicy rejection propagates unchanged, no swallowing here', async () => {
    mockGetConflictPolicy.mockRejectedValueOnce(new Error('DB unreachable'));
    await expect(fetchConflictPolicy(FAKE_DB, 'ws-1')).rejects.toThrow('DB unreachable');
  });

  it('returns whatever getConflictPolicy resolves with, unchanged', async () => {
    mockGetConflictPolicy.mockResolvedValueOnce({ strategy: 'most_recent', config: {} });
    await expect(fetchConflictPolicy(FAKE_DB, 'ws-1')).resolves.toEqual({
      strategy: 'most_recent',
      config: {},
    });
  });
});
