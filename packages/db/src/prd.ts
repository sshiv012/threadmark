/**
 * PRD repositories (MVP-1a): transactional PRD + root-branch creation and
 * workspace-scoped reads. Block creation, version append and forking land in
 * later slices.
 *
 * Read contract: every read takes `workspaceId` and filters on it, so a valid id
 * from another workspace yields `undefined` / `[]`, never a leak. That is data
 * isolation only — it is NOT caller authorization: callers must check
 * membership/`can()` first. Direct getters return archived PRDs and their
 * branches; only `listPrdsByWorkspace` hides archived ones by default.
 */
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { Database } from './client.js';
import { prdBranches, prds, workspaces, type Prd, type PrdBranch } from './schema.js';

export class InvalidPrdTitleError extends Error {}
export class WorkspaceNotFoundError extends Error {}

export const ROOT_BRANCH_NAME = 'main';

/** Create a PRD and its root branch atomically; either both exist or neither. */
export async function createPrd(
  db: Database,
  input: { workspaceId: string; title: string },
): Promise<{ prd: Prd; rootBranch: PrdBranch }> {
  const title = input.title.trim();
  if (title === '') throw new InvalidPrdTitleError('PRD title must not be blank');

  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (!ws) throw new WorkspaceNotFoundError(`workspace ${input.workspaceId} not found`);

    const [prd] = await tx
      .insert(prds)
      .values({ workspaceId: input.workspaceId, title })
      .returning();
    const [rootBranch] = await tx
      .insert(prdBranches)
      .values({ prdId: prd!.id, workspaceId: input.workspaceId, name: ROOT_BRANCH_NAME })
      .returning();
    return { prd: prd!, rootBranch: rootBranch! };
  });
}

export async function getPrd(
  db: Database,
  workspaceId: string,
  prdId: string,
): Promise<Prd | undefined> {
  const [row] = await db
    .select()
    .from(prds)
    .where(and(eq(prds.id, prdId), eq(prds.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

/** Newest first. Archived PRDs are excluded unless `includeArchived`. */
export async function listPrdsByWorkspace(
  db: Database,
  workspaceId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Prd[]> {
  const scope = opts.includeArchived
    ? eq(prds.workspaceId, workspaceId)
    : and(eq(prds.workspaceId, workspaceId), ne(prds.status, 'archived'));
  return db.select().from(prds).where(scope).orderBy(desc(prds.createdAt), desc(prds.id));
}

export async function getPrdBranch(
  db: Database,
  workspaceId: string,
  branchId: string,
): Promise<PrdBranch | undefined> {
  const [row] = await db
    .select()
    .from(prdBranches)
    .where(and(eq(prdBranches.id, branchId), eq(prdBranches.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

/** Oldest first (root branch leads). */
export async function listPrdBranches(
  db: Database,
  workspaceId: string,
  prdId: string,
): Promise<PrdBranch[]> {
  return db
    .select()
    .from(prdBranches)
    .where(and(eq(prdBranches.prdId, prdId), eq(prdBranches.workspaceId, workspaceId)))
    .orderBy(asc(prdBranches.createdAt), asc(prdBranches.name));
}
