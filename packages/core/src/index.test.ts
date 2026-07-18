import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

// Toolchain smoke test: proves Vitest + TypeScript path resolution work across
// the workspace. Real behavioral tests arrive with real behavior.
describe('@threadmark/core', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@threadmark/core');
  });
});
