/**
 * Pure parsing for fixtures/dashboard-sharing/eval-queries.csv.
 *
 * Deliberately stricter than apps/worker/src/cli/manifest.ts's parseManifest
 * (which is positional, unquoted, and doesn't validate the header): this
 * parser already does semantic validation (relevance range/integrality), so
 * mixing that with loose CSV handling would be inconsistent. query/snippet
 * are free natural-language text far more likely to contain commas than
 * manifest.ts's structured slugs, so quoted fields are supported.
 *
 * Resolving `snippet` -> a real chunkSourceKey happens later, against a live
 * DB (see the eval-seed script) — this module only parses CSV -> typed rows.
 */
export interface EvalQueryFixtureRow {
  externalId: string;
  query: string;
  docId: string;
  snippet: string;
  relevance: number;
  notes: string | null;
}

const EXPECTED_HEADER = 'external_id,query,doc_id,snippet,relevance,notes';
const MIN_RELEVANCE = 0;
const MAX_RELEVANCE = 3;

/** Splits one CSV row into fields, honoring "quoted, fields" with "" as an escaped quote. */
function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (inQuotes) {
      if (char === '"') {
        if (row[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"' && current === '') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function requireNonEmpty(value: string, fieldName: string, rowNumber: number): string {
  if (value.trim() === '') {
    throw new Error(`${fieldName} must not be empty (row ${rowNumber})`);
  }
  return value;
}

function parseRelevance(raw: string, rowNumber: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`relevance must be an integer 0-3, got "${raw}" (row ${rowNumber})`);
  }
  if (value < MIN_RELEVANCE || value > MAX_RELEVANCE) {
    throw new Error(`relevance must be in range 0-3, got ${value} (row ${rowNumber})`);
  }
  return value;
}

export function parseEvalQueries(raw: string): EvalQueryFixtureRow[] {
  const lines = raw.trim().split('\n');
  const [header, ...rows] = lines;
  if (header !== EXPECTED_HEADER) {
    throw new Error(`unexpected header row: expected "${EXPECTED_HEADER}", got "${header}"`);
  }

  const seenExternalIdQuery = new Map<string, string>();
  const seenJudgmentKeys = new Set<string>();

  return rows
    .filter((row) => row.trim() !== '')
    .map((row, index) => {
      const rowNumber = index + 2; // header is row 1
      const fields = splitCsvRow(row);
      if (fields.length !== 6) {
        throw new Error(
          `malformed eval-queries row ${rowNumber}: expected 6 columns, got ${fields.length}: ${row}`,
        );
      }
      const [externalIdRaw, queryRaw, docIdRaw, snippetRaw, relevanceRaw, notesRaw] = fields as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];

      const externalId = requireNonEmpty(externalIdRaw, 'external_id', rowNumber);
      const query = requireNonEmpty(queryRaw, 'query', rowNumber);
      const docId = requireNonEmpty(docIdRaw, 'doc_id', rowNumber);
      const snippet = requireNonEmpty(snippetRaw, 'snippet', rowNumber);
      const relevance = parseRelevance(relevanceRaw, rowNumber);
      const notes = notesRaw.trim() === '' ? null : notesRaw;

      const priorQuery = seenExternalIdQuery.get(externalId);
      if (priorQuery !== undefined && priorQuery !== query) {
        throw new Error(
          `inconsistent query text for external_id "${externalId}" (row ${rowNumber}): ` +
            `"${priorQuery}" vs "${query}"`,
        );
      }
      seenExternalIdQuery.set(externalId, query);

      const judgmentKey = `${externalId}|${docId}|${snippet}`;
      if (seenJudgmentKeys.has(judgmentKey)) {
        throw new Error(
          `duplicate judgment for external_id "${externalId}", doc_id "${docId}", ` +
            `snippet "${snippet}" (row ${rowNumber})`,
        );
      }
      seenJudgmentKeys.add(judgmentKey);

      return { externalId, query, docId, snippet, relevance, notes };
    });
}
