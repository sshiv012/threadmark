import { describe, expect, it } from 'vitest';
import { createChunkerRegistry } from './registry.js';

const registry = createChunkerRegistry();

describe('createChunkerRegistry', () => {
  it('routes structured document types to the markdown chunker', () => {
    expect(registry.get('product_doc').name).toBe('markdown');
    expect(registry.get('prior_prd').name).toBe('markdown');
    expect(registry.get('tech_constraint').name).toBe('markdown');
  });

  it('falls back to token-window for everything else (until PR5a-2 adds strategies)', () => {
    expect(registry.get('interview').name).toBe('token-window');
    expect(registry.get('support_ticket').name).toBe('token-window');
    expect(registry.get('analytics').name).toBe('token-window');
    expect(registry.get('anything-unknown').name).toBe('token-window');
  });
});
