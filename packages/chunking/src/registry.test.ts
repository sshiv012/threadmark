import { describe, expect, it } from 'vitest';
import { createChunkerRegistry } from './registry.js';

const registry = createChunkerRegistry();

describe('createChunkerRegistry', () => {
  it('routes structured document types to the markdown chunker', () => {
    expect(registry.get('product_doc').name).toBe('markdown');
    expect(registry.get('prior_prd').name).toBe('markdown');
    expect(registry.get('tech_constraint').name).toBe('markdown');
  });

  it('routes evidence types to their dedicated strategies', () => {
    expect(registry.get('interview').name).toBe('interview-turn');
    expect(registry.get('support_ticket').name).toBe('message');
    expect(registry.get('github_issue').name).toBe('message');
    expect(registry.get('analytics').name).toBe('analytics');
  });

  it('falls back to token-window for unknown types', () => {
    expect(registry.get('other').name).toBe('token-window');
    expect(registry.get('anything-unknown').name).toBe('token-window');
  });
});
