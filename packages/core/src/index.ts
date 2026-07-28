/**
 * @threadmark/core — domain types and the RBAC policy keystone. `Principal`
 * (human | agent-persona) + `can(principal, action, resource)` are the single
 * source of truth every auth boundary (apps/api, packages/agent) consumes.
 */
export const PACKAGE_NAME = '@threadmark/core';

export * from './types.js';
export * from './policy.js';
