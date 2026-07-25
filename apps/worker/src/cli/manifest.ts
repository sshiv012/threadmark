/** Pure parsing for fixtures/dashboard-sharing/manifest.csv (no quoted commas). */
export interface ManifestEntry {
  docId: string;
  sourceType: string;
  effectiveDate: string;
  path: string;
}

export function parseManifest(raw: string): ManifestEntry[] {
  const lines = raw.trim().split('\n');
  const [, ...rows] = lines;
  return rows
    .filter((row) => row.trim() !== '')
    .map((row) => {
      const [docId, sourceType, effectiveDate, path] = row.split(',');
      if (!docId || !sourceType || !effectiveDate || !path) {
        throw new Error(`malformed manifest row: ${row}`);
      }
      return { docId, sourceType, effectiveDate, path };
    });
}
