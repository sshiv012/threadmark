# Collaborative PRD Editor — Architecture & Test Plan

Status: **proposal, not yet implemented**. `apps/collab` is currently a one-line
placeholder (`APP_NAME` export only); no `prd`/`prd_branch`/`prd_block`/`citation`/
`comment` tables exist yet. This doc is the design gate the `test-plan` skill
requires before any of that code gets written, and doubles as the phased delivery
plan for the PRs that will implement it.

All design decisions in this doc are settled as of 2026-08-11 (`prd:manage` is
owner+editor; merge preserves block identity, never re-points; a Hocuspocus
restart accepts bounded edit loss for v1; JWT expiry mid-session triggers a
periodic re-auth disconnect) — none are marked `[NEEDS DECISION]` anymore.
Anything discovered during implementation that contradicts this doc should be
raised as a doc update, not silently built around.

## 1. Scope

A real-time, multi-author PRD editor where humans _and_ agent-personas
(`Principal.kind === 'agent_persona'`, same primitive as `packages/agent`'s
Q&A runtime) co-edit a document built from evidence-backed blocks. CRDT (Yjs)
is the live-editing transport; Postgres remains the system of record, exactly
as `apps/collab/src/index.ts`'s existing placeholder comment already commits
to. Nothing here changes that commitment — this doc specifies how.

Out of scope for v1 (explicitly deferred, not silently dropped):

- True offline-first editing (client keeps writing while fully disconnected,
  for arbitrarily long). v1 supports disconnect → reconnect → resync, not
  extended offline authoring.
- Horizontal scaling of the Hocuspocus server (Redis-backed multi-process
  awareness/doc sharing). v1 is a single process; the seam is designed so
  this can be added later without a schema change.
- Real 3-way semantic merge between branches. See §5.

## 2. Data model (Postgres — source of truth)

Follows this repo's existing conventions exactly (`uuid('id').primaryKey().defaultRandom()`,
`.references(() => t.id, {onDelete:'cascade'})`, `timestamp(..., {withTimezone:true})`).

```ts
export const prds = pgTable(
  'prds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: prdStatus('status').notNull().default('active'), // 'active' | 'archived'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prds_workspace_idx').on(t.workspaceId)],
);

export const prdBranches = pgTable(
  'prd_branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prdId: uuid('prd_id')
      .notNull()
      .references(() => prds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // e.g. 'main', 'alt-pricing-model'
    // Null for a PRD's first/root branch. Points at the branch this one was
    // forked from — lineage only, NOT a merge target; merge is explicit (§5).
    forkedFromBranchId: uuid('forked_from_branch_id').references(() => prdBranches.id, {
      onDelete: 'set null',
    }),
    status: prdBranchStatus('status').notNull().default('active'), // 'active' | 'merged' | 'abandoned'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prd_branches_prd_idx').on(t.prdId),
    uniqueIndex('prd_branches_prd_name_uniq').on(t.prdId, t.name),
  ],
);

// A block's stable identity, shared across EVERY branch of its PRD — never
// branch-scoped. This is what makes "preserve id across merge" (§5, decided)
// trivial rather than requiring re-pointing logic: identity lives here,
// per-branch presence/ordering lives in prdBranchBlocks, per-branch content
// lives in prdBlockVersions. Forking a branch copies prdBranchBlocks rows
// (new branchId, SAME blockId) — identity survives the fork for free.
export const prdBlocks = pgTable(
  'prd_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prdId: uuid('prd_id')
      .notNull()
      .references(() => prds.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'heading' | 'paragraph' | 'list_item' | ... — free text, like chunks/eval configName precedent
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prd_blocks_prd_idx').on(t.prdId)],
);

// Per-branch membership + display order + presence. A block absent from
// this table (or removedAt set) for branch X simply isn't part of X's
// current document — it may still be very much present on other branches.
export const prdBranchBlocks = pgTable(
  'prd_branch_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => prdBranches.id, { onDelete: 'cascade' }),
    blockId: uuid('block_id')
      .notNull()
      .references(() => prdBlocks.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(), // display position within the branch; NOT identity (mirrors chunks.ord)
    // Soft-delete FROM THIS BRANCH ONLY, never hard-deleted — matches this
    // codebase's existing "never silently drop" convention (evidence
    // documents, memberships, agent steps). The block itself (prd_blocks
    // row) is untouched; it may still be live on other branches.
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prd_branch_blocks_branch_idx').on(t.branchId),
    uniqueIndex('prd_branch_blocks_branch_block_uniq').on(t.branchId, t.blockId),
    uniqueIndex('prd_branch_blocks_branch_ord_uniq')
      .on(t.branchId, t.ord)
      .where(sql`removed_at IS NULL`),
  ],
);

// Content is branch-scoped — the same logical block can genuinely diverge
// in content across two branches before a merge reconciles them. A merge
// (§5, decided) appends a version here using the EXACT SAME call path a
// live edit already uses (appendPrdBlockVersion), so merged content lands
// on the target branch's existing block identity automatically — nothing
// is ever re-pointed.
export const prdBlockVersions = pgTable(
  'prd_block_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => prdBlocks.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => prdBranches.id, { onDelete: 'cascade' }),
    content: text('content').notNull(), // reconciled Yjs → plain/rich text at flush time
    contentHash: text('content_hash').notNull(), // skip-if-unchanged, mirrors upsertChunks' contentHash
    // Who produced this version — reuses Principal shape, not a new concept.
    authorKind: text('author_kind').notNull(), // 'human' | 'agent_persona'
    authorSubjectId: text('author_subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prd_block_versions_block_branch_idx').on(t.blockId, t.branchId, t.createdAt)],
);

// Durable natural key, NOT chunks.id — chunks.id is regenerated on
// fresh ingest (see eval_judgments' own precedent for exactly this problem:
// "Durable natural key — NOT chunks.id, which is regenerated on fresh
// ingest"). A citation pinned to chunks.id would silently go stale on the
// next re-ingest even when the underlying content didn't change.
export const citations = pgTable(
  'citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Pinned to a specific (block, branch, point-in-time) version — never
    // the live, still-mutable block.
    blockVersionId: uuid('block_version_id')
      .notNull()
      .references(() => prdBlockVersions.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => evidenceDocuments.id, { onDelete: 'cascade' }),
    chunkSourceKey: text('chunk_source_key').notNull(), // resolves to a live chunk via (documentId, sourceKey)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('citations_block_version_idx').on(t.blockVersionId)],
);

// Branch-scoped like prdBlockVersions: a comment is a discussion about a
// SPECIFIC branch's current state of a block, not a universal property of
// the block's identity — two branches that have diverged in content
// shouldn't share a comment thread silently.
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => prdBlocks.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => prdBranches.id, { onDelete: 'cascade' }),
    parentCommentId: uuid('parent_comment_id').references(() => comments.id, {
      onDelete: 'cascade',
    }),
    authorKind: text('author_kind').notNull(),
    authorSubjectId: text('author_subject_id').notNull(),
    body: text('body').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comments_block_branch_idx').on(t.blockId, t.branchId)],
);
```

Repository function names follow the existing convention exactly (confirmed
against `packages/db/src/repositories.ts`'s current `create<X>`/`get<X>`/
`list<Plural>By<Scope>`/`upsert<X>`/`append<X>` pattern): `createPrd`,
`listPrdsByWorkspace`, `createPrdBranch`, `getPrdBranch`, `listBranchBlocks`
(→ join `prdBranchBlocks`+`prdBlocks`, ordered, excluding `removedAt`),
`upsertPrdBlock` (content-hash-skip like `upsertChunks`),
`appendPrdBlockVersion`, `createCitation`, `createComment`,
`listCommentsByBlock`, `resolveCitation` (→ live chunk via `(documentId,
chunkSourceKey)`, mirroring evals' `resolveRelevanceMap` pattern exactly).

## 3. CRDT / real-time layer (Yjs + Hocuspocus)

- **One `Y.Doc` per `prd_branches` row**, not per PRD — branches are
  independently editable, so they need independent documents. Hocuspocus
  document name: `` `${workspaceId}:${branchId}` `` — the workspaceId prefix
  is defense-in-depth namespacing even though `branchId` is already a UUID
  (mirrors this repo's existing "defense in depth" pattern in
  `getRetrievalChunksByIds`, which re-checks `workspaceId` even though the
  candidate ids theoretically shouldn't have leaked).
- **Block identity inside the doc**: each block is a `Y.XmlElement`/`Y.Map`
  carrying a stable `blockId` attribute (the `prd_blocks.id` UUID) alongside
  its `Y.Text`/`Y.XmlText` content. This is what lets citations and comments
  survive concurrent edits — they pin to `blockId`, never to position.
- **Auth at connection time**: Hocuspocus's `onAuthenticate` hook verifies the
  JWT the same way `apps/api/src/auth/require-auth.ts` already does (same
  `jose` verification, same `sub`-is-a-UUID check), then looks up membership
  for the `workspaceId` parsed out of the document name, then calls
  `can(principal, 'prd:read' | 'prd:write', {type:'prd', workspaceId})`
  depending on whether the connection requests read-write or read-only.
  **A mismatch between the JWT's implied workspace and the document name's
  workspace is rejected at this hook — the connection never reaches the Y.Doc
  merge step.** This is the single most important test in this whole design
  (§9, multi-tenant isolation).
- **`onLoadDocument`**: when the first client connects for a branch, load
  `listBranchBlocks(branchId)` (ordered, excluding `removedAt`) plus each
  block's latest `prd_block_versions` row for that branch, and materialize
  it into a fresh `Y.Doc` before the client's own state syncs in.
- **`onStoreDocument`**: debounced (proposed 3s of inactivity, or every 30s
  under continuous editing, whichever comes first — tunable, not hardcoded).
  Walks the current `Y.Doc`'s blocks, calls `upsertPrdBlock` per block
  (ord/presence in `prd_branch_blocks`, content-hash-skip), and
  `appendPrdBlockVersion` only when a block's content-hash actually changed
  since the last version on this branch — exactly `upsertChunks`' existing
  skip-if-unchanged behavior, reapplied here.
- **Awareness**: presence (cursor, selection, display name) via Yjs's
  standard awareness protocol. An active agent-persona run (e.g. a future
  PRD-drafting agent) publishes itself as an awareness participant too, so
  humans see "PRD Assistant is drafting…" — visually distinct from a human
  cursor, never indistinguishable (transparency, not just a UX nicety).
- **Persistence failure is fail-open for availability, fail-loud for
  durability**: if `onStoreDocument`'s Postgres write fails, the in-memory
  `Y.Doc` keeps accepting edits (editing never stops because of a transient
  DB blip) and the flush retries with backoff; the failure is logged loudly
  (this is the one seam in the whole design where "best-effort and move on"
  is _not_ the right default, unlike `packages/agent`'s observability writes
  — losing PRD content is a real product-level loss, not a lost telemetry
  row).

## 4. RBAC extension (`packages/core`)

New `ResourceType`: `'prd'` (workspace-scoped, matching the existing
`{type, workspaceId}` shape — row-level checks, e.g. "is this branch merged,"
stay in the repository layer, per the existing "`can()` is a policy-shape
decision, not a row-ownership check" rule this repo already follows for
`evidence_document`/`agent_run`).

New `Action` values: `prd:read`, `prd:write`, `prd:comment`, `prd:branch`,
`prd:merge`, `prd:manage` (archive/rename/delete a PRD).

`ROLE_ACTIONS` additions (extending the existing map, not replacing it):

| Role      | prd:read | prd:comment | prd:write | prd:branch | prd:merge | prd:manage |
| --------- | -------- | ----------- | --------- | ---------- | --------- | ---------- |
| owner     | ✓        | ✓           | ✓         | ✓          | ✓         | ✓          |
| editor    | ✓        | ✓           | ✓         | ✓          | ✓         | ✓          |
| commenter | ✓        | ✓           |           |            |           |            |
| viewer    | ✓        |             |           |            |           |            |

**Decided**: `prd:manage` is owner+editor, unlike `workspace:manage_members`
(owner-only). Editors already hold write/branch/merge — archiving/renaming/
deleting a PRD isn't a bigger trust jump for them than those, so this stays a
two-tier model (content-authority roles vs. read-only roles) rather than
introducing a third tier just for this one action. `workspace:manage_members`
itself is untouched by this — that action is a workspace-identity concern,
orthogonal to PRD content authority, and stays owner-only per PR8.

**Agent-persona participation**: `agent_persona` principals get `prd:write`
and `prd:comment` (a drafting/suggestion agent is core to the product,
mirroring how `packages/agent`'s Q&A runtime already reads evidence as a
non-human principal). `prd:merge` and `prd:manage` join the existing
`HUMAN_ONLY_ACTIONS` structural gate — same reasoning PR8 already established
for `workspace:manage_members`: the blast radius of merging/deleting a whole
PRD exceeds what a prompt-injected persona should ever be able to trigger,
regardless of its assigned role.

## 5. Branching & versioning semantics

- A branch is a **fork of the block list at a point in time**: forking copies
  `prdBranchBlocks` rows (same `blockId`s, new `branchId`) into the new
  branch (git-like in spirit, deliberately simpler in mechanics: fork →
  independent linear edit → explicit merge-back; no cherry-picking, no
  rebasing).
- **Merge is a human-reviewed action, not a CRDT operation.** Yjs's CRDT
  guarantees convergence for concurrent edits _within one shared document_ —
  it says nothing about reconciling two independently-forked lineages, which
  is a structural/semantic problem CRDT doesn't solve. Merging branch B back
  into branch A is presented as a block-level diff (added/changed/removed
  blocks by `blockId`) for a human with `prd:merge` to accept — never
  silently auto-applied.
- **Decided: block identity is preserved across a merge, never re-pointed.**
  This falls out of the schema in §2 rather than needing special merge-time
  logic: since a block's `id` was never branch-scoped to begin with, "merge"
  is just — for each `blockId` where A and B's latest content differs —
  calling `appendPrdBlockVersion(blockId, branchId=A, content=B's content)`,
  the exact same call a live edit already makes. Citations and comments
  already attached to A's blocks are untouched by the merge, because nothing
  about the block's identity changed. A block newly created on B (no
  `prdBranchBlocks` row yet on A) gets one inserted, ordered at the position
  the diff view showed; a block removed on B sets `removedAt` on A's
  `prdBranchBlocks` row for it, per the human's reviewed choice — the block
  itself is never deleted, only its presence on that one branch.
- Version granularity is per-block, content-hash-deduped, created at each
  debounced flush — not per-keystroke. A block edited 200 times in one
  30-second burst produces one version row, not 200.

## 6. Citation model

A citation pins a block _version_ (not the live, still-mutable block) to a
durable evidence key: `(documentId, chunkSourceKey)`, exactly the pattern
`eval_judgments` already uses for the identical problem (`chunks.id` is
regenerated on fresh ingest; `(documentId, sourceKey)` survives it). Reading
a citation back resolves it to whatever chunk currently exists at that key —
if none does (the section was removed on re-ingest), the citation is flagged
**stale**, never silently dropped or silently treated as still-valid. This
mirrors `packages/agent`'s existing `citedChunkIds`/`unverifiedCitations`
split: a citation is either currently verifiable or explicitly flagged, never
a silent pass.

## 7. Failure modes & edge cases (CRDT-specific)

- **Simultaneous same-position edits**: Yjs's algorithm guarantees
  convergence without data loss, but two users typing at the exact same
  cursor position can interleave into a garbled-looking (though
  data-preserving) result. This is an accepted CRDT tradeoff, not a bug —
  document it as such rather than trying to "fix" it with locking.
- **Reconnect after network drop**: Yjs resyncs cleanly; already-sent updates
  before the drop are not rolled back (CRDT has no partial-edit undo).
- **Hocuspocus process restart**: `onLoadDocument` rehydrates from the last
  _persisted_ state. Edits made since the last debounced flush before the
  restart are lost. **Decided: accept this v1 limitation**, bounded by the
  debounce window (e.g. ≤30s of loss) — no client-side replay buffer for v1.
  Revisit only if this proves painful in practice; a restart is rare, and
  the loss window is small by construction.
- **JWT expiry mid-session**: a WS connection authenticated once at connect
  time doesn't automatically re-check auth as the JWT ages. **Decided:
  periodic re-auth check** (proposed every 5 min — tunable, not a fixed
  constant), disconnecting the client on failure. A revoked/demoted
  membership takes effect within that bounded window, not "whenever this
  tab happens to reload."
- **Malformed/oversized Yjs update from a compromised or buggy client**:
  Hocuspocus doesn't validate CRDT update _semantics_ — the persistence-layer
  reconciliation (`onStoreDocument`) is the actual trust boundary and must
  independently re-validate business invariants (max block size, no
  cross-branch `blockId` collision, sanitize before render if content is
  rich text) before writing to Postgres. This is the same "validate at
  boundaries, trust nothing upstream" rule this repo already applies
  everywhere else.

## 8. Phased delivery plan

Same one-behavior-per-PR discipline as PR8–PR11. Proposed sequence (each
still needs its own `test-plan` gate before code):

1. **PRD data model** — schema + repositories only, no real-time layer.
   Same shape as PR3/PR8 (schema-first, heavily unit-tested via pglite).
2. **RBAC extension** — `prd:*` actions in `packages/core`, extends
   `can()`/`ROLE_ACTIONS` + the human-only structural gate. Mirrors PR8
   exactly, on top of (1).
3. **Hocuspocus auth + multi-tenant namespacing, in-memory only** — no
   Postgres persistence yet. Proves the transport/isolation layer in
   isolation before wiring it to anything durable.
4. **Postgres persistence bridge** — `onLoadDocument`/`onStoreDocument`
   wiring (1)+(3) together.
5. **`apps/web` editor UI** — block editor (Tiptap/ProseMirror +
   `y-websocket` provider) against (4).
6. **Branching** — create/list branches, merge-as-reviewed-diff flow.
7. **Citations + comments UI** — wired to the existing evidence corpus.
8. **Agent-persona participation** — a PRD-drafting agent run that writes
   blocks through the same repositories as a human, appears in awareness.

## 9. Test plan

Grouped by this repo's own mandatory categories (`test-plan` skill).

### Happy path

- `packages/db` [pglite] → creating a branch, upserting blocks, appending
  versions round-trips exactly; a second flush with unchanged content
  creates zero new version rows (content-hash skip).
- `packages/db` [pglite] → a citation resolves to the correct live chunk via
  `(documentId, chunkSourceKey)`.
- `packages/core` [unit] → owner/editor `can()` prd:write/branch/merge; all
  four roles `can()` prd:read.
- `apps/collab` [integration, real Hocuspocus + in-memory Yjs clients] → two
  clients connected to the same branch see each other's edits without a
  Postgres round trip.
- `apps/collab` [integration] → a debounced flush persists current Yjs
  content into `prd_branch_blocks`/`prd_block_versions` with correct
  ord/content.
- `apps/collab` [integration] → an agent-persona-authored block round-trips
  with `authorKind: 'agent_persona'`, otherwise identical shape to a human's.

### Negative / adversarial

- `apps/collab` [integration] → a JWT valid for workspace A connecting to a
  document namespaced `${workspaceB}:${branchId}` is rejected at
  `onAuthenticate`; the Y.Doc for B is never touched, never merges A's state.
- `apps/collab` [integration] → a fuzzed/malformed Yjs binary update does not
  crash the process or corrupt other connected clients' state.
- `apps/collab` [integration] → an oversized single block (e.g. multi-MB
  paste) is rejected/bounded at the persistence-reconciliation step, not
  silently accepted into Postgres.
- `packages/core` [unit] → a `commenter` principal's `prd:write` call denies;
  content unchanged.
- `packages/core` [unit] → a non-owner's `prd:merge`/`prd:manage` call
  denies, including an `agent_persona` with `role:'owner'` (human-only gate).
- `packages/db` [pglite] → a citation pointing at a `(documentId,
chunkSourceKey)` that no longer resolves to a live chunk is flagged stale,
  not silently treated as valid.

### Edge / boundary / validation

- `packages/db` [pglite] → an empty branch (zero blocks) round-trips without
  crashing; a branch forked from an empty branch is also empty, not an error.
- `packages/db` [pglite] → two concurrent block-inserts racing for the same
  `ord` on the same branch resolve deterministically with no duplicate `ord`
  under `prd_branch_blocks_branch_ord_uniq`'s `removed_at IS NULL` partial
  unique index.
- `packages/db` [pglite] → a deeply nested comment thread (e.g. 50 levels)
  doesn't stack-overflow a recursive listing — bounded depth or iterative
  resolution.
- `apps/collab` [integration] → the debounce boundary itself: an edit at
  T+2.9s (just under the 3s debounce) does NOT trigger an early flush; an
  edit at T+3.1s does.

### Multi-tenant isolation (hard gate)

- `apps/collab` [integration] → **the single most important test in this
  design**: exhaustively confirm a workspace-A-authenticated connection can
  never join, read, or write a workspace-B document, including by directly
  crafting/guessing a `${workspaceB}:${branchId}` document name client-side.
- `packages/db` [pglite] → `listPrdsByWorkspace` never returns another
  workspace's rows, even with identical PRD titles across workspaces.
- `packages/db` [pglite] → two workspaces' branches with the identical name
  (`'main'`) never collide — `prd_branches_prd_name_uniq` is scoped by
  `prdId`, and two different workspaces' `prds` rows are already distinct.

### Failure / degradation

- `apps/collab` [integration] → Postgres unreachable during a flush: the
  in-memory `Y.Doc` keeps accepting edits; once Postgres recovers, the next
  successful flush persists the latest state with no data loss (test: kill
  Postgres mid-session, edit, restore Postgres, assert eventual consistency).
- `apps/collab` [integration] → process restart: `onLoadDocument` rehydrates
  from the last persisted flush; edits after that flush are lost (assert the
  _bounded_ loss matches the debounce window, per §7's accepted limitation —
  this test exists specifically to keep that bound honest, not just to prove
  "it works").
- `apps/collab` [integration] → a client disconnecting mid-edit clears its
  awareness entry; already-applied updates before the drop remain applied
  (no rollback).
- `apps/collab` [integration] → a connection whose JWT has expired is
  force-disconnected on the next periodic re-auth check (§7, decided), not
  left open until the client happens to disconnect on its own.

### State filtering

- `apps/collab` [integration] → an archived PRD's branches are not joinable
  via Hocuspocus even with a previously-valid, still-cached document name.
- `apps/collab` [integration] → a `merged`-status branch rejects a write at
  the persistence-reconciliation level even though the in-memory CRDT itself
  would accept the edit — merged branches are read-only.

### Re-ingest / edit / delete

- `packages/db` [pglite] → editing a block's content preserves its `id`
  across versions — citations/comments made against an earlier version still
  resolve to the same block.
- `packages/db` [pglite] → removing a block from a branch sets
  `prd_branch_blocks.removedAt`, never a hard delete of the `prd_blocks` row
  — existing citations/comments/versions against it remain resolvable
  (rendered as "this block was removed from this branch," not a broken
  foreign key), and the same block can still be present and live on another
  branch that never removed it.
- `packages/db` [pglite] → re-ingesting the underlying evidence document
  (content changes, `chunks.id` regenerates) leaves existing citations
  resolvable via `(documentId, chunkSourceKey)` — the exact scenario this
  key choice exists to survive (§6).
- `packages/db` [pglite] → merging branch B into branch A (§5, decided)
  appends new `prd_block_versions` rows on A's existing `blockId`s — a
  citation created against A's pre-merge version still resolves to the same
  `blockId`, and a NEW citation created after the merge against A's
  post-merge version is a distinct row, not a mutation of the old one.

### Version / config drift

- `apps/collab` [integration] → an old persisted block/version row (written
  before a future schema addition, e.g. a new block `type`) still loads
  without crashing `onLoadDocument` — forward-compatible reconciliation.
- Manual checklist (no automated test yet): a Yjs major-version upgrade
  doesn't corrupt previously-persisted state — call out as a required manual
  verification step before any such upgrade ships, not silently assumed safe.

### Provenance / correctness

- `packages/db` [pglite] → `prd_block_versions` for a given block are
  strictly ordered by `createdAt` with no gaps introduced by the
  content-hash skip (skipping a version is correct, not a bug — this test
  proves the skip doesn't also skip recording _which_ flush cycle it was).
- `apps/collab` [integration] → the state resolvable from Postgres alone
  (no live Yjs session) always matches exactly what the last successful
  flush wrote — one atomic transaction per flush, never a partial write
  visible mid-flush.
- `packages/db` [pglite] → an agent-drafted block's citation to a chunk
  never actually returned by that agent's own search — mirrors
  `packages/agent`'s existing `unverifiedCitations` mechanism — is flagged
  distinctly, never silently accepted as verified provenance.

### UX states

- `apps/web` [manual/e2e, once (5) exists] → loading state while the Y.Doc
  syncs on first connect; presence indicators appear/disappear correctly as
  users join/leave; a comment on a since-removed block renders "removed,"
  not a crash; an actively-drafting agent-persona shows a visually distinct
  indicator from a human cursor.

### Non-functional bounds (call out, not necessarily enforced in v1)

- Soft cap on concurrent editors per branch given a single-process
  Hocuspocus (no Redis-backed scaling yet) — call out a number to watch
  (e.g. "dozens, not thousands"), not a hard-enforced limit.
- Debounce interval (3s idle / 30s continuous, proposed) is a tunable
  latency-vs-write-amplification tradeoff, not a fixed constant — expose as
  config.
- Max block size / total blocks per branch before editor performance
  degrades — flag as a design-review item for (5), no enforcement code
  required yet.
