import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

describe('parseManifest', () => {
  it('parses rows into structured entries', () => {
    const raw = `doc_id,source_type,effective_date,path
prd-a,prior_prd,2025-06-15,prior-prd/prd-a.md
interview-b,interview,2025-10-05,interviews/interview-b.md
`;
    const entries = parseManifest(raw);
    expect(entries).toEqual([
      {
        docId: 'prd-a',
        sourceType: 'prior_prd',
        effectiveDate: '2025-06-15',
        path: 'prior-prd/prd-a.md',
      },
      {
        docId: 'interview-b',
        sourceType: 'interview',
        effectiveDate: '2025-10-05',
        path: 'interviews/interview-b.md',
      },
    ]);
  });

  it('ignores trailing blank lines', () => {
    const raw = 'doc_id,source_type,effective_date,path\na,t,2025-01-01,p/a.md\n\n';
    expect(parseManifest(raw)).toHaveLength(1);
  });

  it('throws on a malformed row (missing column)', () => {
    const raw = 'doc_id,source_type,effective_date,path\na,t,2025-01-01\n';
    expect(() => parseManifest(raw)).toThrow(/malformed/i);
  });

  it('returns an empty array for a header-only manifest', () => {
    expect(parseManifest('doc_id,source_type,effective_date,path\n')).toEqual([]);
  });
});
