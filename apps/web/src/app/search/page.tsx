import { findOrCreateWorkspaceByName } from '@threadmark/db';
import type { RetrievalResult } from '@threadmark/retrieval';
import { env } from '../../lib/env';
import { getDb, getRetriever } from '../../lib/services';

export const dynamic = 'force-dynamic';

function toNumber(value: string | undefined): number | undefined {
  const n = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; k?: string; n?: string }>;
}) {
  const { q, k, n } = await searchParams;
  const candidateK = toNumber(k);
  const topK = toNumber(n);
  let result: RetrievalResult | null = null;
  if (q && q.trim() !== '') {
    const workspace = await findOrCreateWorkspaceByName(getDb(), env.workspaceName);
    result = await getRetriever().search(q, {
      workspaceId: workspace.id,
      ...(candidateK !== undefined ? { candidateK } : {}),
      ...(topK !== undefined ? { topK } : {}),
    });
  }

  return (
    <>
      <h1>Search</h1>
      <form method="get" className="search-form">
        <input type="search" name="q" defaultValue={q ?? ''} placeholder="Search the evidence…" />
        <input
          type="number"
          name="k"
          defaultValue={k ?? ''}
          min={1}
          placeholder="candidates (30)"
          title="candidateK — fewer = faster rerank"
        />
        <button type="submit">Search</button>
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
