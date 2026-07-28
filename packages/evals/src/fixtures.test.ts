import { describe, expect, it } from 'vitest';
import { parseEvalQueries } from './fixtures.js';

const HEADER = 'external_id,query,doc_id,snippet,relevance,notes';

describe('parseEvalQueries', () => {
  describe('happy path', () => {
    it('parses well-formed rows into typed rows with relevance coerced to a number', () => {
      const raw = `${HEADER}
link-expiry-01,set an expiry date on a share link,link-settings-expiry-and-revoke,link expires after,3,primary
link-expiry-01,set an expiry date on a share link,ticket-1042-link-expired-too-soon,expired too soon,2,
`;
      expect(parseEvalQueries(raw)).toEqual([
        {
          externalId: 'link-expiry-01',
          query: 'set an expiry date on a share link',
          docId: 'link-settings-expiry-and-revoke',
          snippet: 'link expires after',
          relevance: 3,
          notes: 'primary',
        },
        {
          externalId: 'link-expiry-01',
          query: 'set an expiry date on a share link',
          docId: 'ticket-1042-link-expired-too-soon',
          snippet: 'expired too soon',
          relevance: 2,
          notes: null,
        },
      ]);
    });

    it('supports a quoted field containing an embedded comma', () => {
      const raw = `${HEADER}
q1,"how do I share, revoke, and audit a link",doc-a,"a snippet, with a comma",1,
`;
      const rows = parseEvalQueries(raw);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        query: 'how do I share, revoke, and audit a link',
        snippet: 'a snippet, with a comma',
      });
    });

    it('ignores trailing blank lines', () => {
      const raw = `${HEADER}\nq1,query text,doc-a,snippet text,1,\n\n`;
      expect(parseEvalQueries(raw)).toHaveLength(1);
    });

    it('returns an empty array for a header-only fixture', () => {
      expect(parseEvalQueries(`${HEADER}\n`)).toEqual([]);
    });

    it('the same external_id across multiple rows (one query, many judgments) is valid, not an error', () => {
      const raw = `${HEADER}
q1,shared query text,doc-a,snippet a,3,
q1,shared query text,doc-b,snippet b,1,
`;
      expect(parseEvalQueries(raw)).toHaveLength(2);
    });

    it('notes is the one column allowed empty, parsed as null', () => {
      const raw = `${HEADER}\nq1,query,doc-a,snippet,2,\n`;
      expect(parseEvalQueries(raw)[0]!.notes).toBeNull();
    });

    it('relevance boundaries 0 and 3 are both accepted', () => {
      const raw = `${HEADER}
q1,query,doc-a,snippet,0,
q2,query,doc-b,snippet,3,
`;
      const rows = parseEvalQueries(raw);
      expect(rows[0]!.relevance).toBe(0);
      expect(rows[1]!.relevance).toBe(3);
    });
  });

  describe('negative / adversarial', () => {
    it('throws on a row with a missing column', () => {
      const raw = `${HEADER}\nq1,query,doc-a,snippet,2\n`;
      expect(() => parseEvalQueries(raw)).toThrow(/row 2/);
    });

    it('throws on a row with an extra column', () => {
      const raw = `${HEADER}\nq1,query,doc-a,snippet,2,note,extra\n`;
      expect(() => parseEvalQueries(raw)).toThrow(/row 2/);
    });

    it('throws on non-numeric relevance, naming "relevance" specifically', () => {
      const raw = `${HEADER}\nq1,query,doc-a,snippet,high,\n`;
      expect(() => parseEvalQueries(raw)).toThrow(/relevance/i);
    });

    it.each(['4', '-1'])(
      'throws on out-of-range relevance %s, stating the valid range',
      (value) => {
        const raw = `${HEADER}\nq1,query,doc-a,snippet,${value},\n`;
        expect(() => parseEvalQueries(raw)).toThrow(/0.*3|0-3/);
      },
    );

    it('throws on non-integer relevance (1.5)', () => {
      const raw = `${HEADER}\nq1,query,doc-a,snippet,1.5,\n`;
      expect(() => parseEvalQueries(raw)).toThrow(/relevance/i);
    });

    it.each([
      [',query,doc-a,snippet,2,', 'external_id'],
      ['q1,,doc-a,snippet,2,', 'query'],
      ['q1,query,,snippet,2,', 'doc_id'],
      ['q1,query,doc-a,,2,', 'snippet'],
    ])('throws when a required field is empty: %s', (row) => {
      const raw = `${HEADER}\n${row}\n`;
      expect(() => parseEvalQueries(raw)).toThrow();
    });

    it('throws when the same external_id has inconsistent query text across rows', () => {
      const raw = `${HEADER}
q1,query version A,doc-a,snippet a,3,
q1,query version B,doc-b,snippet b,1,
`;
      expect(() => parseEvalQueries(raw)).toThrow(/external_id|q1/i);
    });

    it('throws on an exact duplicate row (same external_id, doc_id, and snippet repeated)', () => {
      const raw = `${HEADER}
q1,shared query,doc-a,snippet a,3,
q1,shared query,doc-a,snippet a,3,
`;
      expect(() => parseEvalQueries(raw)).toThrow(/duplicate/i);
    });

    it('throws when the header row does not match the expected columns', () => {
      const raw = 'id,query,doc,snippet,score,notes\nq1,query,doc-a,snippet,2,\n';
      expect(() => parseEvalQueries(raw)).toThrow(/header/i);
    });
  });
});
