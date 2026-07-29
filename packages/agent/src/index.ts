/**
 * @threadmark/agent — a single-persona, single-tool cited Q&A runtime built
 * on the Vercel AI SDK. Not a multi-step planner and not PRD generation (no
 * prd_block table exists to write to yet) — deliberately scoped small.
 */
export const PACKAGE_NAME = '@threadmark/agent';

export * from './config.js';
export * from './model.js';
export * from './runAgentQuery.js';
export * from './tools/searchEvidence.js';
export * from './types.js';
