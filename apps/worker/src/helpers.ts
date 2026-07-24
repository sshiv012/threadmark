import { basename, dirname, extname } from 'node:path';
import type { EvidenceSourceType } from '@threadmark/db';

const DIR_TO_SOURCE_TYPE: Record<string, EvidenceSourceType> = {
  interviews: 'interview',
  'support-tickets': 'support_ticket',
  'prior-prd': 'prior_prd',
  'product-docs': 'product_doc',
  analytics: 'analytics',
  'tech-constraints': 'tech_constraint',
};

/** Infer the evidence source type from the file's parent folder, then extension. */
export function inferSourceType(filePath: string): EvidenceSourceType {
  const parent = basename(dirname(filePath));
  const byDir = DIR_TO_SOURCE_TYPE[parent];
  if (byDir) return byDir;
  if (extname(filePath) === '.csv') return 'analytics';
  return 'other';
}

export function inferContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.md':
      return 'text/markdown';
    case '.csv':
      return 'text/csv';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
