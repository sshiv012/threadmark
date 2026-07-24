import { findOrCreateWorkspaceByName } from '@threadmark/db';
import type { RetrievalResult } from '@threadmark/retrieval';
import { env } from '../../lib/env';
import { getDb, getRetriever } from '../../lib/services';

export const dynamic = 'force-dynamic';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  let result: RetrievalResult | null = null;
  if (q && q.trim() !== '') {
    const workspace = await findOrCreateWorkspaceByName(getDb(), env.workspaceName);
    result = await getRetriever().search(q, { workspaceId: workspace.id });
  }

  return (
    <>
      <h1>Search</h1>
      <form method="get">
        <input type="search" name="q" defaultValue={q ?? ''} placeholder="Search the evidence…" />
      </form>

      {result ? (
        <>
          <h2>
            {result.results.length} results ·{' '}
            <span className="muted">
              {result.latencyMs}ms {result.cached ? '(cached)' : ''}
            </span>
          </h2>
          {result.results.map((hit, i) => (
            <div className="card" key={hit.chunkId}>
              <div>
                <strong>
                  {i + 1}. {hit.documentTitle}
                </strong>{' '}
                <span className="muted">[{hit.sourceType}]</span>
                <span className="muted">
                  {' '}
                  · rerank {hit.rerankScore.toFixed(3)}
                  {hit.vectorRank ? ` · vec#${hit.vectorRank}` : ''}
                  {hit.lexicalRank ? ` · bm25#${hit.lexicalRank}` : ''}
                </span>
              </div>
              <div className="snippet">{hit.text.replace(/\s+/g, ' ').slice(0, 260)}</div>
            </div>
          ))}
        </>
      ) : (
        <div className="card muted">
          Enter a query to run hybrid retrieval (vector + BM25 → rerank).
        </div>
      )}
    </>
  );
}
