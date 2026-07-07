import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Production source trees — the security package itself is exempt (it crafts attacks). */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const productionDirs = [
  'apps/hub/src',
  'packages/protocol/src',
  'packages/game-server-sdk/src',
  'packages/game-frontend-sdk/src',
  'packages/krmx-adapter/src',
  'examples/tictactoe/frontend/src',
  'examples/tictactoe/server/src',
  'examples/tictactoe/provisioner/src',
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const allFiles = productionDirs.flatMap((dir) => sourceFiles(path.join(repoRoot, dir)));

describe('H — hygiene', () => {
  it('H-01 no HS256 / shared-secret ticket paths in production code', () => {
    const offenders = allFiles.filter((file) => /HS256/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it("H-02 every jwtVerify call site passes the explicit algorithms: ['RS256'] allowlist", () => {
    let callSites = 0;
    const offenders: string[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/jwtVerify\(/g)?.length ?? 0;
      if (calls === 0) continue;
      callSites += calls;
      if (!source.includes("algorithms: ['RS256']")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // not vacuous: the game-server-sdk verifier must exist
    expect(callSites).toBeGreaterThanOrEqual(1);
  });
});
