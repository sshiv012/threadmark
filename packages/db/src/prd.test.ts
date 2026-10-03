import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  createPrd,
  getPrd,
  getPrdBranch,
  InvalidPrdTitleError,
  listPrdBranches,
  listPrdsByWorkspace,
  WorkspaceNotFoundError,
} from './prd.js';
import { createWorkspace } from './repositories.js';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let db: Database;
let pg: PGlite | undefined;

beforeEach(async () => {
  pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb;
});

// Assigned before migrate(), so this still closes the instance if setup fails.
afterEach(async () => {
  await pg?.close();
  pg = undefined;
});

/** Run a statement that must fail; return the Postgres SQLSTATE + constraint name. */
async function violation(
  p: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause ?? e;
    const { code, constraint } = cause as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error('expected a constraint violation, but the statement succeeded');
}

async function count(table: PgTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row!.n;
}

const PRD_TABLES = [
  schema.prds,
  schema.prdBranches,
  schema.prdBlocks,
  schema.prdBranchBlocks,
  schema.prdBlockVersions,
];

async function seedTwoWorkspaces() {
  const a = await createWorkspace(db, { name: 'A' });
  const b = await createWorkspace(db, { name: 'B' });
  return { a, b };
}

/** A PRD with one block associated to its root branch (ord 0). */
async function seedPrdWithBlock(workspaceId: string, title = 'Dashboard sharing') {
  const { prd, rootBranch } = await createPrd(db, { workspaceId, title });
  const [block] = await db
    .insert(schema.prdBlocks)
    .values({ prdId: prd.id, type: 'paragraph' })
    .returning();
  await db
    .insert(schema.prdBranchBlocks)
    .values({ prdId: prd.id, branchId: rootBranch.id, blockId: block!.id, ord: 0 });
  return { prd, rootBranch, block: block! };
}

describe('createPrd', () => {
  it('creates an active PRD with exactly one root branch "main" in the same workspace', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd, rootBranch } = await createPrd(db, { workspaceId: a.id, title: '  Sharing  ' });

    expect(prd).toMatchObject({ workspaceId: a.id, title: 'Sharing', status: 'active' });
    expect(rootBranch).toMatchObject({
      prdId: prd.id,
      workspaceId: a.id,
      name: 'main',
      forkedFromBranchId: null,
      status: 'active',
    });
    expect(await listPrdBranches(db, a.id, prd.id)).toHaveLength(1);
  });

  it('allows the same title twice (no idempotency in this slice): two PRDs, two roots', async () => {
    const { a } = await seedTwoWorkspaces();
    await createPrd(db, { workspaceId: a.id, title: 'Same' });
    await createPrd(db, { workspaceId: a.id, title: 'Same' });
    expect(await count(schema.prds)).toBe(2);
    expect(await count(schema.prdBranches)).toBe(2);
  });

  it.each(['', '   ', '\n\t'])('rejects blank title %j and writes nothing', async (title) => {
    const { a } = await seedTwoWorkspaces();
    await expect(createPrd(db, { workspaceId: a.id, title })).rejects.toBeInstanceOf(
      InvalidPrdTitleError,
    );
    expect(await count(schema.prds)).toBe(0);
  });

  it('rejects an unknown workspace with a typed error and writes nothing', async () => {
    await expect(
      createPrd(db, { workspaceId: '00000000-0000-4000-8000-000000000000', title: 'X' }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(await count(schema.prds)).toBe(0);
  });

  it('rolls back the PRD when root-branch creation fails inside the real transaction', async () => {
    const { a } = await seedTwoWorkspaces();
    // Test-only fault injection at the SQL level: no hook exists in production code.
    await db.execute(sql`CREATE FUNCTION fail_branch_insert() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'injected branch failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER fail_branch_insert BEFORE INSERT ON prd_branches
      FOR EACH ROW EXECUTE FUNCTION fail_branch_insert()`);

    await expect(createPrd(db, { workspaceId: a.id, title: 'Doomed' })).rejects.toThrow();

    expect(await count(schema.prds)).toBe(0);
    expect(await count(schema.prdBranches)).toBe(0);
  });
});

describe('workspace-scoped reads', () => {
  it('never returns another workspace PRDs or branches, even with identical titles', async () => {
    const { a, b } = await seedTwoWorkspaces();
    const inA = await createPrd(db, { workspaceId: a.id, title: 'Same' });
    const inB = await createPrd(db, { workspaceId: b.id, title: 'Same' });

    expect((await listPrdsByWorkspace(db, a.id)).map((p) => p.id)).toEqual([inA.prd.id]);
    expect(await getPrd(db, a.id, inA.prd.id)).toMatchObject({ id: inA.prd.id });
    // Right id, wrong workspace → undefined / [] (never throws, never leaks).
    expect(await getPrd(db, b.id, inA.prd.id)).toBeUndefined();
    expect(await getPrdBranch(db, b.id, inA.rootBranch.id)).toBeUndefined();
    expect(await listPrdBranches(db, b.id, inA.prd.id)).toEqual([]);
    expect(await getPrdBranch(db, b.id, inB.rootBranch.id)).toMatchObject({ prdId: inB.prd.id });
  });

  it('archived PRDs: hidden from the list by default, still readable by direct getters', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd, rootBranch } = await createPrd(db, { workspaceId: a.id, title: 'Old' });
    await db.update(schema.prds).set({ status: 'archived' }).where(eq(schema.prds.id, prd.id));

    expect(await listPrdsByWorkspace(db, a.id)).toEqual([]);
    expect(await listPrdsByWorkspace(db, a.id, { includeArchived: true })).toHaveLength(1);
    expect(await getPrd(db, a.id, prd.id)).toMatchObject({ status: 'archived' });
    expect(await getPrdBranch(db, a.id, rootBranch.id)).toBeDefined();
    expect(await listPrdBranches(db, a.id, prd.id)).toHaveLength(1);
  });
});

describe('integrity (database-enforced)', () => {
  it('rejects a branch whose workspace differs from its PRD workspace', async () => {
    const { a, b } = await seedTwoWorkspaces();
    const { prd, rootBranch } = await createPrd(db, { workspaceId: a.id, title: 'P' });
    // A fork (so the root-uniqueness index is not what fires) claiming workspace B.
    expect(
      await violation(
        db.insert(schema.prdBranches).values({
          prdId: prd.id,
          workspaceId: b.id,
          name: 'x',
          forkedFromBranchId: rootBranch.id,
        }),
      ),
    ).toEqual({ code: '23503', constraint: 'prd_branches_prd_workspace_fk' });
  });

  it('at most one root branch per PRD (index guarantees ≤1; createPrd guarantees exactly 1)', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd } = await createPrd(db, { workspaceId: a.id, title: 'P' });
    expect(
      await violation(
        db.insert(schema.prdBranches).values({ prdId: prd.id, workspaceId: a.id, name: 'other' }),
      ),
    ).toEqual({ code: '23505', constraint: 'prd_branches_root_uniq' });
  });

  it('branch names are unique within a PRD but reusable across PRDs', async () => {
    const { a } = await seedTwoWorkspaces();
    const p1 = await createPrd(db, { workspaceId: a.id, title: 'P1' });
    const p2 = await createPrd(db, { workspaceId: a.id, title: 'P2' });
    const fork = (prdId: string, from: string) =>
      db
        .insert(schema.prdBranches)
        .values({ prdId, workspaceId: a.id, name: 'main', forkedFromBranchId: from });
    expect(await violation(fork(p1.prd.id, p1.rootBranch.id))).toEqual({
      code: '23505',
      constraint: 'prd_branches_prd_name_uniq',
    });
    await db.insert(schema.prdBranches).values({
      prdId: p2.prd.id,
      workspaceId: a.id,
      name: 'alt',
      forkedFromBranchId: p2.rootBranch.id,
    });
  });

  it('forkedFromBranchId must be a branch of the SAME PRD, and never itself', async () => {
    const { a } = await seedTwoWorkspaces();
    const p1 = await createPrd(db, { workspaceId: a.id, title: 'P1' });
    const p2 = await createPrd(db, { workspaceId: a.id, title: 'P2' });
    const insert = (forkedFromBranchId: string, id?: string) =>
      db
        .insert(schema.prdBranches)
        .values({ id, prdId: p1.prd.id, workspaceId: a.id, name: 'alt', forkedFromBranchId });

    expect(await violation(insert(p2.rootBranch.id))).toEqual({
      code: '23503',
      constraint: 'prd_branches_fork_source_fk',
    });
    const selfId = '11111111-1111-4111-8111-111111111111';
    expect(await violation(insert(selfId, selfId))).toEqual({
      code: '23514',
      constraint: 'prd_branches_no_self_fork',
    });
    await insert(p1.rootBranch.id); // same PRD: allowed
  });

  it('a branch-block must pair a branch and a block of the same PRD', async () => {
    const { a } = await seedTwoWorkspaces();
    const p1 = await seedPrdWithBlock(a.id, 'P1');
    const p2 = await seedPrdWithBlock(a.id, 'P2');
    const assoc = (prdId: string, branchId: string, blockId: string, ord: number) =>
      db.insert(schema.prdBranchBlocks).values({ prdId, branchId, blockId, ord });

    expect(await violation(assoc(p2.prd.id, p2.rootBranch.id, p1.block.id, 5))).toEqual({
      code: '23503',
      constraint: 'prd_branch_blocks_block_fk',
    });
    expect(await violation(assoc(p2.prd.id, p1.rootBranch.id, p2.block.id, 5))).toEqual({
      code: '23503',
      constraint: 'prd_branch_blocks_branch_fk',
    });
  });

  it('ord is unique among active rows on a branch; a removed row may share it', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd, rootBranch, block } = await seedPrdWithBlock(a.id);
    const [b2] = await db.insert(schema.prdBlocks).values({ prdId: prd.id, type: 'p' }).returning();
    const add = (blockId: string, ord: number, removedAt?: Date) =>
      db
        .insert(schema.prdBranchBlocks)
        .values({ prdId: prd.id, branchId: rootBranch.id, blockId, ord, removedAt });

    expect(await violation(add(b2!.id, 0))).toEqual({
      code: '23505',
      constraint: 'prd_branch_blocks_branch_ord_uniq',
    });
    expect(await violation(add(b2!.id, -1))).toEqual({
      code: '23514',
      constraint: 'prd_branch_blocks_ord_nonneg',
    });
    await add(b2!.id, 0, new Date()); // soft-removed: frees the slot
    expect(await violation(add(block.id, 9))).toEqual({
      code: '23505',
      constraint: 'prd_branch_blocks_branch_block_uniq',
    });
  });

  it('a version must reference an existing branch-block association, not just a valid block and branch', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd, rootBranch, block } = await seedPrdWithBlock(a.id);
    const fork = await db
      .insert(schema.prdBranches)
      .values({ prdId: prd.id, workspaceId: a.id, name: 'alt', forkedFromBranchId: rootBranch.id })
      .returning();
    const version = (branchId: string, seq = 1, authorKind = 'human') =>
      db.insert(schema.prdBlockVersions).values({
        blockId: block.id,
        branchId,
        seq,
        content: 'hello',
        contentHash: 'h',
        authorKind,
        authorSubjectId: 'u1',
      });

    // block + fork branch are each valid and in the same PRD, but not associated.
    expect(await violation(version(fork[0]!.id))).toEqual({
      code: '23503',
      constraint: 'prd_block_versions_assoc_fk',
    });
    await version(rootBranch.id);
    expect(await violation(version(rootBranch.id))).toEqual({
      code: '23505',
      constraint: 'prd_block_versions_seq_uniq',
    });
    expect(await violation(version(rootBranch.id, 0))).toEqual({
      code: '23514',
      constraint: 'prd_block_versions_seq_pos',
    });
    expect(await violation(version(rootBranch.id, 2, 'robot'))).toEqual({
      code: '23514',
      constraint: 'prd_block_versions_author_kind',
    });
  });
});

describe('cascades and delete actions', () => {
  async function seedVersioned(workspaceId: string, title: string) {
    const s = await seedPrdWithBlock(workspaceId, title);
    await db.insert(schema.prdBlockVersions).values({
      blockId: s.block.id,
      branchId: s.rootBranch.id,
      seq: 1,
      content: 'x',
      contentHash: 'h',
      authorKind: 'human',
      authorSubjectId: 'u1',
    });
    return s;
  }

  it('deleting a PRD removes every dependent row and leaves other PRDs intact', async () => {
    const { a } = await seedTwoWorkspaces();
    const keep = await seedVersioned(a.id, 'keep');
    const gone = await seedVersioned(a.id, 'gone');
    await db.delete(schema.prds).where(eq(schema.prds.id, gone.prd.id));
    for (const table of PRD_TABLES) expect(await count(table)).toBe(1);
    expect(await getPrd(db, a.id, keep.prd.id)).toBeDefined();
  });

  it('deleting a workspace removes all of its PRD rows but not another workspace', async () => {
    const { a, b } = await seedTwoWorkspaces();
    await seedVersioned(a.id, 'a');
    await seedVersioned(b.id, 'b');
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, a.id));
    for (const table of PRD_TABLES) expect(await count(table)).toBe(1);
  });

  /** A fork of the root branch that holds the block plus one version of its own. */
  async function seedFork(s: Awaited<ReturnType<typeof seedVersioned>>, workspaceId: string) {
    const [fork] = await db
      .insert(schema.prdBranches)
      .values({
        prdId: s.prd.id,
        workspaceId,
        name: 'alt',
        forkedFromBranchId: s.rootBranch.id,
      })
      .returning();
    await db
      .insert(schema.prdBranchBlocks)
      .values({ prdId: s.prd.id, branchId: fork!.id, blockId: s.block.id, ord: 0 });
    await db.insert(schema.prdBlockVersions).values({
      blockId: s.block.id,
      branchId: fork!.id,
      seq: 1,
      content: 'forked',
      contentHash: 'h2',
      authorKind: 'human',
      authorSubjectId: 'u1',
    });
    return fork!;
  }

  it('deleting a PRD that has forks succeeds: the NO ACTION fork FK is checked after the whole cascade', async () => {
    const { a } = await seedTwoWorkspaces();
    const s = await seedVersioned(a.id, 'forked');
    await seedFork(s, a.id);
    await db.delete(schema.prds).where(eq(schema.prds.id, s.prd.id));
    for (const table of PRD_TABLES) expect(await count(table)).toBe(0);
  });

  it('deleting a branch cascades its associations and versions but keeps the block and other branches', async () => {
    const { a } = await seedTwoWorkspaces();
    const s = await seedVersioned(a.id, 'P');
    const fork = await seedFork(s, a.id);
    await db.delete(schema.prdBranches).where(eq(schema.prdBranches.id, fork.id));
    expect(await count(schema.prdBlocks)).toBe(1);
    expect(await count(schema.prdBranchBlocks)).toBe(1);
    expect(await count(schema.prdBlockVersions)).toBe(1);
    expect(await getPrdBranch(db, a.id, s.rootBranch.id)).toBeDefined();
  });

  it('a fork source cannot be deleted while a fork exists; deleting the fork keeps blocks and the source branch data', async () => {
    const { a } = await seedTwoWorkspaces();
    const { prd, rootBranch, block } = await seedVersioned(a.id, 'P');
    const [fork] = await db
      .insert(schema.prdBranches)
      .values({ prdId: prd.id, workspaceId: a.id, name: 'alt', forkedFromBranchId: rootBranch.id })
      .returning();
    await db
      .insert(schema.prdBranchBlocks)
      .values({ prdId: prd.id, branchId: fork!.id, blockId: block.id, ord: 0 });

    expect(
      await violation(
        db.delete(schema.prdBranches).where(eq(schema.prdBranches.id, rootBranch.id)),
      ),
    ).toEqual({ code: '23503', constraint: 'prd_branches_fork_source_fk' });

    await db.delete(schema.prdBranches).where(eq(schema.prdBranches.id, fork!.id));
    expect(await count(schema.prdBlocks)).toBe(1);
    expect(await count(schema.prdBranchBlocks)).toBe(1);
    expect(await count(schema.prdBlockVersions)).toBe(1);
  });
});
