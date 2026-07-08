import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Matrix-coverage meta-test (docs/SECURITY-TEST-PLAN.md §3, "CI gate").
 *
 * Parses the test matrix out of the plan and checks it against the matrix IDs
 * found in test titles across this package. Every milestone that lands moves
 * its rows (§4 mapping) into LANDED_ROWS; a landed row without a matching
 * test title fails this suite. M0 lands no rows, so LANDED_ROWS is empty and
 * the coverage check passes vacuously.
 */

// §4 milestone mapping — uncomment each milestone's rows when it lands.
const LANDED_ROWS: string[] = [
  // M1
  'A-01', 'A-02', 'A-05', 'A-08', 'A-09',
  // M2
  'T-01', 'T-02', 'T-03', 'T-04', 'T-05', 'T-06', 'T-07', 'T-08', 'T-09', 'T-10', 'T-11',
  'A-03', 'A-04', 'A-10', 'H-01', 'H-02',
  // M3 (P-05 deferred: conditional on an origin-vetting feature not yet
  // specified; A-06/A-07 land here since the registry authz is built now).
  'P-01', 'P-02', 'P-03', 'P-04', 'P-06',
  'S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-07',
  'L-09', 'A-06', 'A-07',
  // M4 (S-06 lands with the results endpoint built here)
  'L-01', 'L-02', 'L-03', 'L-04', 'L-05', 'L-06', 'L-07', 'L-08', 'L-10',
  'S-06',
  // M5: 'F-01'..'F-07', 'S-06', 'H-04',
];

const securityRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.resolve(securityRoot, '../docs/SECURITY-TEST-PLAN.md');

// Matrix rows are markdown table lines whose first cell is an ID like T-02.
const MATRIX_ROW = /^\|\s*([TASLPFH]-\d{2})\b/;

function parseMatrixIds(): string[] {
  const plan = readFileSync(planPath, 'utf8');
  return plan
    .split('\n')
    .map((line) => MATRIX_ROW.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(full));
    else if (/\.(test|spec)\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

// IDs count as covered only when they appear in an it(...)/test(...) title.
const TEST_TITLE = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])([\s\S]*?)\1/g;
const MATRIX_ID = /\b[TASLPFH]-\d{2}\b/g;

function collectTitleIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of collectTestFiles(securityRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(TEST_TITLE)) {
      for (const id of (match[2] ?? '').match(MATRIX_ID) ?? []) {
        ids.add(id);
      }
    }
  }
  return ids;
}

const matrixIds = parseMatrixIds();
const titleIds = collectTitleIds();

describe('security matrix coverage (meta)', () => {
  it('parses the full test matrix from SECURITY-TEST-PLAN.md', () => {
    expect(matrixIds.length).toBeGreaterThanOrEqual(55);
    expect(new Set(matrixIds).size).toBe(matrixIds.length);
    for (const sentinel of ['T-01', 'T-11', 'A-10', 'S-07', 'L-10', 'P-06', 'F-07', 'H-04']) {
      expect(matrixIds).toContain(sentinel);
    }
  });

  it('every matrix ID referenced in a test title exists in the plan', () => {
    const unknown = [...titleIds].filter((id) => !matrixIds.includes(id));
    expect(unknown).toEqual([]);
  });

  it('every landed matrix row has a matching test title', () => {
    const invalid = LANDED_ROWS.filter((id) => !matrixIds.includes(id));
    expect(invalid).toEqual([]);

    const missing = LANDED_ROWS.filter((id) => !titleIds.has(id));
    expect(missing).toEqual([]);
  });
});
