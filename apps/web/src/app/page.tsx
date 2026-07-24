import {
  findOrCreateWorkspaceByName,
  listAgentRuns,
  listAgentSteps,
  listEvidenceDocuments,
} from '@threadmark/db';
import { env } from '../lib/env';
import { getDb } from '../lib/services';

// Rendered per request (reads live DB state); never statically prerendered.
export const dynamic = 'force-dynamic';

function fmt(date: Date | null): string {
  return date ? new Date(date).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

export default async function DocumentsPage() {
  const db = getDb();
  const workspace = await findOrCreateWorkspaceByName(db, env.workspaceName);
  const documents = await listEvidenceDocuments(db, workspace.id);
  const runs = await listAgentRuns(db, workspace.id, 8);
  const runsWithSteps = await Promise.all(
    runs.map(async (run) => ({ run, steps: await listAgentSteps(db, run.id) })),
  );

  return (
    <>
      <h1>Documents</h1>
      <div className="muted">
        Workspace: {workspace.name} · {documents.length} documents
      </div>

      <h2>Evidence</h2>
      <div className="card">
        {documents.length === 0 ? (
          <div className="muted">
            Nothing ingested yet. Run `pnpm seed` (worker must be running).
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.title}</td>
                  <td className="muted">{doc.sourceType}</td>
                  <td>
                    <span className={`badge ${doc.status}`}>{doc.status}</span>
                    {doc.statusReason ? <div className="snippet">{doc.statusReason}</div> : null}
                  </td>
                  <td className="muted">{fmt(doc.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Recent ingestion runs</h2>
      {runsWithSteps.length === 0 ? (
        <div className="card muted">No runs yet.</div>
      ) : (
        runsWithSteps.map(({ run, steps }) => (
          <div className="card" key={run.id}>
            <div>
              <span className={`badge ${run.status}`}>{run.status}</span> {run.kind}{' '}
              <span className="muted">· started {fmt(run.startedAt)}</span>
            </div>
            <table>
              <tbody>
                {steps.map((step) => (
                  <tr key={step.id}>
                    <td className="muted">#{step.ord}</td>
                    <td>{step.type}</td>
                    <td>
                      <span className={`badge ${step.status}`}>{step.status}</span>
                    </td>
                    <td className="muted">attempt {step.attempt}</td>
                    <td className="snippet">{step.error ?? step.outputSummary ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
