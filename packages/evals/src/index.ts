/**
 * @threadmark/evals — labeled retrieval evaluation set, metrics (precision@k,
 * recall@k, MRR, nDCG@k), an offline runner, and a report. Evaluation is
 * introduced immediately after retrieval (PR7), not deferred to the end.
 */
export const PACKAGE_NAME = '@threadmark/evals';

export * from './arms.js';
export * from './fixtures.js';
export * from './metrics.js';
export * from './runner.js';
