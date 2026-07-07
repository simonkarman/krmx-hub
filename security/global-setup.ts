import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boots the hub (production build, `next start`) on :3210 for HTTP-level
 * security tests. Runs migrations first (idempotent). Reuses an existing
 * .next build when present — `pnpm test` runs after `pnpm build` — and
 * builds one otherwise.
 */
const securityRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(securityRoot, '..');
const hubDir = path.join(repoRoot, 'apps', 'hub');
const PORT = 3210;
const HUB_URL = `http://localhost:${PORT}`;

let child: ChildProcess | undefined;
let output = '';

export async function setup(): Promise<void> {
  execFileSync('node', [path.join(hubDir, 'db', 'migrate.mjs')], { stdio: 'inherit' });

  if (!existsSync(path.join(hubDir, '.next', 'BUILD_ID'))) {
    execFileSync('pnpm', ['--filter', 'hub', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }

  child = spawn(path.join(hubDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(PORT)], {
    cwd: hubDir,
    env: {
      ...process.env,
      AUTH_SECRET: 'security-test-secret',
      AUTH_URL: HUB_URL,
      AUTH_TRUST_HOST: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  child.on('exit', () => (exited = true));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`hub exited during startup:\n${output}`);
    try {
      const res = await fetch(`${HUB_URL}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`hub did not become ready on ${HUB_URL}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function teardown(): Promise<void> {
  child?.kill('SIGTERM');
}
